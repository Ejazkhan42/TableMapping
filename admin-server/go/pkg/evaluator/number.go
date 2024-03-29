package evaluator

import "tableflow/go/pkg/util"

type NumberEvaluator struct{}

func (e *NumberEvaluator) Initialize(_ interface{}) error {
	return nil
}

func (e NumberEvaluator) Evaluate(cell string) (bool, string, error) {
	_, str, err := util.StringToNumberOrNil(cell)
	return err == nil, str, nil
}

func (e NumberEvaluator) DefaultMessage() string {
	return "The cell must be a number"
}

func (e NumberEvaluator) AllowedDataTypes() []string {
	return []string{"number"}
}
