"use client";

interface DownloadButtonProps {
  onDownload: () => void;
  isDownloading: boolean;
}

export default function DownloadButton({
  onDownload,
  isDownloading,
}: DownloadButtonProps) {
  return (
    <button
      type="button"
      onClick={onDownload}
      disabled={isDownloading}
      className="btn-primary w-full py-4 text-lg flex items-center justify-center gap-3"
    >
      {isDownloading ? (
        <>
          <svg
            className="animate-spin h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Starting Download Job...
        </>
      ) : (
        <>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
          </svg>
          Queue This Video Download
        </>
      )}
    </button>
  );
}
