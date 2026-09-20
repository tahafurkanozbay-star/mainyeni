import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
} from "react";
import { BiX } from "react-icons/bi";
import "./FileUpload.css";

export interface FileUploadProps {
  readonly setFiles: (files: FileList | null) => void;
  readonly accept?: string;
  readonly disabled?: boolean;
  readonly maxBytes?: number;
  readonly onRejected?: (reason: string) => void;
}

const firstFile = (files: FileList | null): File | null =>
  files && files.length > 0 ? files.item(0) : null;

export const FileUpload = ({
  setFiles,
  accept,
  disabled = false,
  maxBytes = 25 * 1024 * 1024,
  onRejected,
}: FileUploadProps) => {
  const controlId = useId().replaceAll(":", "");
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [files, setLocalFiles] = useState<FileList | null>(null);

  const applyFiles = (next: FileList | null): void => {
    const file = firstFile(next);
    if (!file) {
      setLocalFiles(null);
      setFiles(null);
      return;
    }
    if (file.size > maxBytes) {
      onRejected?.(`Dosya boyutu ${Math.round(maxBytes / 1024 / 1024)} MB sınırını aşıyor.`);
      return;
    }
    setLocalFiles(next);
    setFiles(next);
  };

  const handleDrag = (event: DragEvent<HTMLFormElement | HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    if (event.type === "dragenter" || event.type === "dragover") setDragActive(true);
    if (event.type === "dragleave") setDragActive(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (!disabled) applyFiles(event.dataTransfer.files);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    applyFiles(event.target.files);
  };

  const removeFile = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (inputRef.current) inputRef.current.value = "";
    applyFiles(null);
  };

  const selected = firstFile(files);

  return (
    <div>
      <form
        id={`form-file-upload-${controlId}`}
        className="form-file-upload"
        onDragEnter={handleDrag}
        onSubmit={(event) => event.preventDefault()}
      >
        <input
          ref={inputRef}
          type="file"
          id={`input-file-upload-${controlId}`}
          className="input-file-upload"
          multiple={false}
          accept={accept}
          disabled={disabled}
          onChange={handleChange}
        />
        <label
          id={`label-file-upload-${controlId}`}
          htmlFor={`input-file-upload-${controlId}`}
          className={dragActive ? "drag-active label-file-upload" : "label-file-upload"}
        >
          <div>
            {selected ? (
              <div className="mb-2">
                <button
                  type="button"
                  onClick={removeFile}
                  className="btn btn-outline-secondary"
                  aria-label={`${selected.name} dosyasını kaldır`}
                >
                  {selected.name} <BiX title="Vazgeç" aria-hidden="true" />
                </button>
              </div>
            ) : null}
            <p>Dosyanızı buraya sürükleyip bırakın</p>
            <button
              type="button"
              className="upload-button"
              onClick={() => inputRef.current?.click()}
              disabled={disabled}
            >
              ya da yüklemek için bir dosya seçin
            </button>
          </div>
        </label>
        {dragActive ? (
          <div
            className="drag-file-element"
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            aria-hidden="true"
          />
        ) : null}
      </form>
    </div>
  );
};
