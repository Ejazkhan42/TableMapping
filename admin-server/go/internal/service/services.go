package service

import (
	"context"
	"errors"
	"fmt"
	"github.com/gocql/gocql"
	"github.com/joho/godotenv"
	"go.uber.org/zap"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"log"
	"os"
	"sync"
	"tableflow/go/pkg/db"
	"tableflow/go/pkg/file"
	"tableflow/go/pkg/scylla"
	"tableflow/go/pkg/tf"
	"tableflow/go/pkg/util"
	"tableflow/go/pkg/web"
	"time"
)

var loggerInitialized bool
var envInitialized bool
var dbInitialized bool
var scyllaInitialized bool
var tempStorageInitialized bool

func InitServices(ctx context.Context, wg *sync.WaitGroup) {
	var err error

	/* Logger */
	wg.Add(1)
	err = initLogger(ctx, wg)
	if err != nil {
		log.Printf("Error initializing logger: %v", err.Error())
		return
	}

	/* Environment */
	err = initEnv()
	if err != nil {
		tf.Log.Errorw("Error initializing env", "error", err)
		return
	}

	/* Postgres */
	err = initDatabase()
	if err != nil {
		tf.Log.Fatalw("Error initializing database", "error", err)
		return
	}

	/* Scylla */
	wg.Add(1)
	err = initScylla(ctx, wg)
	if err != nil {
		tf.Log.Fatalw("Error initializing Scylla", "error", err)
		return
	}

	/* Temp Storage */
	wg.Add(1)
	err = initTempStorage(ctx, wg)
	if err != nil {
		tf.Log.Fatalw("Error initializing temp storage", "error", err)
		return
	}

	/* Web Server */
	wg.Add(1)
	err = initWebServer(ctx, wg)
	if err != nil {
		tf.Log.Fatalw("Error initializing web server", "error", err)
		return
	}
}

func initLogger(ctx context.Context, wg *sync.WaitGroup) error {
	if loggerInitialized {
		return errors.New("logger already initialized")
	}
	loggerInitialized = true

	zapLogger, _ := zap.NewDevelopment()
	tf.Log = zapLogger.Sugar()

	go util.ShutdownHandler(ctx, wg, func() { tf.Log.Sync() })
	return nil
}

func initEnv() error {
	if envInitialized {
		return errors.New("env already initialized")
	}
	envInitialized = true

	// Used for docker deploy, the env is copied from the base directory to the backend directory
	_ = godotenv.Load(".env")
	// Used for development, the env exists only in the base directory
	_ = godotenv.Load("../.env")

	return nil
}

func initDatabase() error {
	if dbInitialized {
		return errors.New("db already initialized")
	}
	dbInitialized = true
	var err error

	postgresSSLMode := "disable"        // TODO: Support SSL
	postgresTZ := "America/Los_Angeles" // TODO: Add timezone support from system
	postgresDefaultPort := "5432"

	postgresHost := os.Getenv("POSTGRES_HOST")
	postgresPort := os.Getenv("POSTGRES_PORT")
	postgresUser := os.Getenv("POSTGRES_USER")
	postgresPass := os.Getenv("POSTGRES_PASSWORD")
	postgresName := os.Getenv("POSTGRES_DATABASE_NAME")

	if len(postgresPort) == 0 {
		postgresPort = postgresDefaultPort
	}
	if len(postgresHost) == 0 {
		return errors.New("missing POSTGRES_HOST in env")
	}
	if len(postgresUser) == 0 {
		return errors.New("missing POSTGRES_USER in env")
	}
	if len(postgresPass) == 0 {
		return errors.New("missing POSTGRES_PASSWORD in env")
	}
	if len(postgresName) == 0 {
		return errors.New("missing POSTGRES_DATABASE_NAME in env")
	}

	dsn := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s TimeZone=%s",
		postgresHost,
		postgresPort,
		postgresUser,
		postgresPass,
		postgresName,
		postgresSSLMode,
		postgresTZ)

	tf.DB, err = gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		return err
	}
	if err = tf.DB.Exec(db.GetDatabaseSchemaInitSQL()).Error; err != nil {
		tf.Log.Errorw("Error running standard database initialization SQL", "error", err)
		return err
	}
	return nil
}

func initScylla(ctx context.Context, wg *sync.WaitGroup) error {
	if scyllaInitialized {
		return errors.New("scylla already initialized")
	}
	scyllaInitialized = true

	scyllaHost := os.Getenv("SCYLLA_HOST")
	scyllaUser := os.Getenv("SCYLLA_USER")
	scyllaPass := os.Getenv("SCYLLA_PASSWORD")
	authEnabled := len(scyllaUser) != 0 && len(scyllaPass) != 0

	if len(scyllaHost) == 0 {
		return errors.New("missing SCYLLA_HOST in env")
	}

	systemCfg := gocql.NewCluster(scyllaHost)
	systemCfg.Keyspace = "system"
	if authEnabled {
		systemCfg.Authenticator = gocql.PasswordAuthenticator{
			Username: scyllaUser,
			Password: scyllaPass,
		}
	}
	systemSession, err := systemCfg.CreateSession()
	if err != nil {
		return err
	}
	if err = systemSession.Query(scylla.GetScyllaKeyspaceConfigurationCQL()).Exec(); err != nil {
		systemSession.Close()
		return err
	}
	systemSession.Close()

	clusterCfg := gocql.NewCluster(scyllaHost)
	clusterCfg.Keyspace = "tableflow"
	if authEnabled {
		clusterCfg.Authenticator = gocql.PasswordAuthenticator{
			Username: scyllaUser,
			Password: scyllaPass,
		}
	}
	clusterCfg.Consistency = gocql.One
	clusterCfg.Timeout = time.Second * 20
	clusterCfg.WriteTimeout = time.Second * 30
	clusterCfg.RetryPolicy = &gocql.ExponentialBackoffRetryPolicy{
		NumRetries: 2,
		Min:        500 * time.Millisecond,
		Max:        1 * time.Second,
	}

	clusterCfg.PoolConfig = gocql.PoolConfig{
		HostSelectionPolicy: gocql.TokenAwareHostPolicy(gocql.RoundRobinHostPolicy()),
	}

	tf.Scylla, err = clusterCfg.CreateSession()
	if err != nil {
		return err
	}
	for _, stmt := range scylla.GetScyllaSchemaConfigurationCQL() {
		if err = tf.Scylla.Query(stmt).Exec(); err != nil {
			tf.Scylla.Close()
			return err
		}
	}

	go util.ShutdownHandler(ctx, wg, func() { tf.Scylla.Close() })
	return nil
}

func initTempStorage(ctx context.Context, wg *sync.WaitGroup) error {
	if tempStorageInitialized {
		return errors.New("temp storage already initialized")
	}
	tempStorageInitialized = true

	err := file.CreateTempDirectories()
	if err != nil {
		return err
	}

	go util.ShutdownHandler(ctx, wg, func() { file.RemoveTempDirectories() })
	return nil
}

func initWebServer(ctx context.Context, wg *sync.WaitGroup) error {
	server := web.StartFileImportServer()

	go util.ShutdownHandler(ctx, wg, func() {
		if err := server.Shutdown(ctx); err != nil {
			tf.Log.Fatalw("File import server forced to shutdown", "error", err)
		}
		tf.Log.Debugw("File import server shutdown")
	})
	return nil
}
