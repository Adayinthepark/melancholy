"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type MutableRefObject,
} from "react";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type UploadFiles = (files: File[]) => Promise<void>;
const FileDropContext =
  createContext<MutableRefObject<UploadFiles | null> | null>(null);

export function useChatFileDrop(upload: UploadFiles) {
  const target = useContext(FileDropContext);
  useEffect(() => {
    if (!target) return;
    target.current = upload;
    return () => {
      if (target.current === upload) target.current = null;
    };
  }, [target, upload]);
}

export function ChatFileDrop({
  children,
  className,
  contextKey,
  ...props
}: ComponentProps<"div"> & { contextKey: string }) {
  const upload = useRef<UploadFiles | null>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  function reset() {
    depth.current = 0;
    setDragging(false);
  }
  useEffect(() => {
    reset();
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, [contextKey]);
  return (
    <FileDropContext.Provider value={upload}>
      <div
        {...props}
        className={cn("chat-file-drop", className)}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          depth.current++;
          if (upload.current) setDragging(true);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = upload.current ? "copy" : "none";
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          reset();
          if (!upload.current) return;
          const items = Array.from(e.dataTransfer.items).filter(
            (item) => item.kind === "file",
          );
          const hasDirectory = items.some(
            (item) => item.webkitGetAsEntry?.()?.isDirectory,
          );
          if (hasDirectory) {
            toast.error(
              "Folders aren't supported. Drop individual files instead.",
            );
            return;
          }
          void upload.current(Array.from(e.dataTransfer.files));
        }}
      >
        {children}
        {dragging && (
          <div className="chat-file-drop-overlay" role="status">
            <Upload aria-hidden="true" />
            <span>Drop files to attach</span>
          </div>
        )}
      </div>
    </FileDropContext.Provider>
  );
}
