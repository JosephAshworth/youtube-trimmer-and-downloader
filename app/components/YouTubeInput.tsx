"use client";

import { useRef, useState } from "react";

export type VideoSourceMode = "youtube" | "upload";

interface YouTubeInputProps {
  mode: VideoSourceMode;
  onModeChange: (mode: VideoSourceMode) => void;
  url: string;
  onUrlChange: (url: string) => void;
  onProcess: () => void;
  onUpload: (file: File) => void;
  isLoading: boolean;
  uploadProgress: number | null;
}

export default function YouTubeInput({
  mode,
  onModeChange,
  url,
  onUrlChange,
  onProcess,
  onUpload,
  isLoading,
  uploadProgress,
}: YouTubeInputProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);

  const handleModeChange = (next: VideoSourceMode) => {
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    onModeChange(next);
  };

  const handleYouTubeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onProcess();
  };

  const handleUploadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    onUpload(file);
  };

  const uploadLabel =
    isLoading && uploadProgress !== null
      ? `Uploading ${uploadProgress}%`
      : isLoading
        ? "Uploading..."
        : "Use this video";

  return (
    <div className="flex flex-col gap-4 w-full">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Video source">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "youtube"}
          onClick={() => handleModeChange("youtube")}
          className={mode === "youtube" ? "btn-primary px-4 py-2 text-sm" : "btn-secondary px-4 py-2 text-sm"}
        >
          YouTube link
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "upload"}
          onClick={() => handleModeChange("upload")}
          className={mode === "upload" ? "btn-primary px-4 py-2 text-sm" : "btn-secondary px-4 py-2 text-sm"}
        >
          Upload file
        </button>
      </div>

      {mode === "youtube" ? (
        <form onSubmit={handleYouTubeSubmit} className="flex flex-col sm:flex-row gap-3 w-full">
          <input
            type="url"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="Paste any YouTube link (public or unlisted)..."
            className="input-glow flex-1 text-base"
            required
          />
          <button
            type="submit"
            disabled={isLoading || !url.trim()}
            className="btn-primary whitespace-nowrap"
          >
            {isLoading ? "Processing..." : "Process Video"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleUploadSubmit} className="flex flex-col gap-3 w-full">
          <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <input
              ref={fileRef}
              type="file"
              accept="video/*,.mp4,.m4v,.webm,.mov,.mkv,.avi,.mpeg,.mpg,.wmv,.flv,.3gp,.ogv"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="btn-secondary whitespace-nowrap"
              disabled={isLoading}
            >
              Choose video
            </button>
            <p className="text-sm text-gray-300 truncate flex-1">
              {file ? file.name : "No file selected"}
            </p>
            <button
              type="submit"
              disabled={isLoading || !file}
              className="btn-primary whitespace-nowrap"
            >
              {uploadLabel}
            </button>
          </div>
          <p className="text-xs text-gray-400">
            MP4, MOV, WebM, MKV, and other video files. Up to 2 GB.
          </p>
        </form>
      )}
    </div>
  );
}
