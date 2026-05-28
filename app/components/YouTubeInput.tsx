"use client";

interface YouTubeInputProps {
  url: string;
  onUrlChange: (url: string) => void;
  onProcess: () => void;
  isLoading: boolean;
}

export default function YouTubeInput({
  url,
  onUrlChange,
  onProcess,
  isLoading,
}: YouTubeInputProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onProcess();
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3 w-full">
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
  );
}
