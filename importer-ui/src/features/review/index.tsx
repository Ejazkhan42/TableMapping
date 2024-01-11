import { CellValueChangedEvent } from "ag-grid-community";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@chakra-ui/button";
import Errors from "../../components/Errors";
import ToggleFilter from "../../components/ToggleFilter";
import { Option } from "../../components/ToggleFilter/types";
import { post } from "../../api/api";
import { QueryFilter } from "../../api/types";
import useSubmitReview from "../../api/useSubmitReview";
import useThemeStore from "../../stores/theme";
import ReviewDataTable from "./components/ReviewDataTable";
import { ReviewProps } from "./types";
import style from "./style/Review.module.scss";
import Complete from "../complete";

const defaultOptions: Option[] = [
  { label: "All (0)", filterValue: "all", selected: true },
  { label: "Valid (0)", filterValue: "valid", selected: false },
  { label: "Error (0)", filterValue: "error", selected: false, color: "#f04339" },
];

type FilterOptionCounts = {
  NumRows: number;
  NumValidRows: number;
  NumErrorRows: number;
};

export default function Review({
  onCancel,
  onComplete,
  waitOnComplete,
  upload,
  template,
  review,
  reload,
  close,
  columnsOrder,
  schemaless,
}: ReviewProps) {
  const uploadId = upload?.id;
  const filter = useRef<QueryFilter>("all");
  const [filterOptions, setFilterOptions] = useState<Option[]>(defaultOptions);
  const [isSubmitCompleted, setIsSubmitCompleted] = useState(false);
  const [hasDataErrors, setHasDataErrors] = useState(false);
  const { mutate, error: submitError, isSuccess, isLoading: isSubmitting, data: dataSubmitted } = useSubmitReview(uploadId || "");
  const [waitOnCompleteLoading, setWaitOnCompleteLoading] = useState(false);
  const theme = useThemeStore((state) => state.theme);
  const hasValidations = template.columns.some((tc) => tc.validations && tc.validations.length > 0);
  const cellValueChangeSet = useRef(new Set<string>());
  const onCellValueChanged = useCallback((event: CellValueChangedEvent) => {
    const { rowIndex, column, data, newValue, oldValue, api } = event;
    const columnId = column.getColId();
    const cellId = `${rowIndex}-${columnId}`;

    // Check if the change was done programmatically to not cause an infinite loop when reverting changes to cell edits
    if (cellValueChangeSet.current.has(cellId)) {
      cellValueChangeSet.current.delete(cellId);
      return;
    }

    // Extract the cell key from column ID
    const parts = columnId.split(".");
    let cellKey = "";
    if (parts.length > 1 && parts[0] === "values") {
      cellKey = parts[1];
    } else {
      console.error("Unexpected column ID format", columnId);
      return;
    }

    const endpoint = `import/${uploadId}/cell/edit`;
    const body = {
      row_index: data?.index,
      cell_key: cellKey,
      cell_value: newValue ?? "",
    };
    post(endpoint, body).then((res) => {
      const rowNode = api?.getRowNode(String(rowIndex));
      if (!rowNode) {
        console.error("Unable to retrieve row node from event API", rowIndex);
        return;
      }
      if (!res.ok) {
        cellValueChangeSet.current.add(cellId);
        rowNode.setDataValue(columnId, oldValue);
        alert(res.error);
        return;
      }

      if (res.data?.row?.errors && res.data.row.errors[cellKey]) {
        // The edit caused a validation error, update the row node errors
        rowNode.data.errors = rowNode.data.errors || {};
        rowNode.data.errors[cellKey] = res.data.row.errors[cellKey];
      } else if (data?.errors && rowNode.data?.errors[cellKey]) {
        // The edit passed validations, remove the error from the row node
        delete rowNode.data.errors[cellKey];
        if (Object.keys(rowNode.data.errors).length === 0) {
          rowNode.data.errors = undefined;
        }
      }

      // If the data returned is different from the edit value, update the cell data (can happen with data type conversions)
      if (res.data?.row?.values && res.data.row.values[cellKey] !== newValue) {
        cellValueChangeSet.current.add(cellId);
        rowNode.setDataValue(columnId, res.data.row.values[cellKey]);
      }

      // Refresh the row to update the styling
      api?.refreshCells({ rowNodes: [rowNode], columns: [columnId], force: true });

      // Update the has data errors state
      setHasDataErrors(res.data?.num_error_rows > 0);

      // Update the counts on the filter options
      updateFilterOptions(
        filter.current,
        res.data ? { NumRows: res.data.num_rows, NumValidRows: res.data.num_valid_rows, NumErrorRows: res.data.num_error_rows } : undefined
      );
    });
  }, []);

  useEffect(() => {
    if (isSuccess) {
      setIsSubmitCompleted(true);
      onComplete(dataSubmitted?.data);
    }
  }, [isSuccess, submitError]);

  // Load the initial state from the data returned
  useEffect(() => {
    updateFilterOptions(
      filter.current,
      review ? { NumRows: review?.num_rows, NumValidRows: review?.num_valid_rows, NumErrorRows: review?.num_error_rows } : undefined
    );
    if (review) {
      setHasDataErrors(review?.num_error_rows > 0);
    }
  }, [JSON.stringify(review)]);

  const updateFilterOptions = useCallback((option: string, counts?: FilterOptionCounts) => {
    filter.current = option as QueryFilter;
    setFilterOptions(
      filterOptions.map((fo) => {
        fo.selected = fo.filterValue === option;
        if (counts) {
          switch (fo.filterValue) {
            case "all":
              fo.label = `All ${counts.NumRows}`;
              break;
            case "valid":
              fo.label = `Valid ${counts.NumValidRows}`;
              break;
            case "error":
              fo.label = `Error ${counts.NumErrorRows}`;
              break;
          }
        }
        return fo;
      })
    );
  }, []);

  const handleSubmitClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (waitOnComplete) {
      setWaitOnCompleteLoading(true);
    }
    e.preventDefault();
    mutate({ uploadId: uploadId });
  };

  const handleImportAlreadySubmitted = () => {
    reload();
  };

  if (isSubmitCompleted && !waitOnComplete) {
    return <Complete reload={reload} close={close} upload={upload} showImportLoadingStatus={false} />;
  }

  return (
    <>
      <div className={style.reviewContainer}>
        {hasValidations && (
          <ToggleFilter options={filterOptions} className={style.filters} onChange={(option: string) => updateFilterOptions(option)} />
        )}
        <div className={style.tableWrapper}>
          <ReviewDataTable
            onCellValueChanged={onCellValueChanged}
            template={template}
            columnsOrder={columnsOrder}
            theme={theme}
            uploadId={uploadId}
            filter={filter.current}
            disabled={isSubmitting || waitOnCompleteLoading}
            upload={upload}
            onImportAlreadySubmitted={handleImportAlreadySubmitted}
            schemaless={schemaless}
          />
        </div>
        <div className={style.actions}>
          <Button type="button" colorScheme="secondary" onClick={onCancel} isDisabled={isSubmitting || waitOnCompleteLoading}>
            Back
          </Button>
          <Button
            title={hasDataErrors ? "Please resolve all errors before submitting" : ""}
            colorScheme="primary"
            isDisabled={hasDataErrors}
            onClick={handleSubmitClick}
            isLoading={isSubmitting || waitOnCompleteLoading}>
            Submit
          </Button>
        </div>
      </div>
      {!!submitError && (
        <div className={style.errorContainer}>
          <Errors error={submitError} />
        </div>
      )}
    </>
  );
}
