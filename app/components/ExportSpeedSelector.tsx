"use client";

import { EXPORT_SPEED_OPTIONS, type ExportSpeed } from "@/lib/utils";

interface ExportSpeedSelectorProps {
  value: ExportSpeed;
  onChange: (speed: ExportSpeed) => void;
  disabled?: boolean;
}

export default function ExportSpeedSelector({
  value,
  onChange,
  disabled = false,
}: ExportSpeedSelectorProps) {
  return (
    <fieldset className="glass-panel p-4 flex flex-col gap-3" disabled={disabled}>
      <legend className="text-sm font-semibold text-white px-1">Export speed</legend>
      <div className="flex flex-col sm:flex-row gap-3">
        {EXPORT_SPEED_OPTIONS.map((option) => {
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              className={`flex-1 cursor-pointer rounded-lg border px-4 py-3 transition-colors ${
                selected
                  ? "border-[var(--accent)] bg-[var(--accent)]/10"
                  : "border-white/10 bg-white/5 hover:border-white/20"
              } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
            >
              <input
                type="radio"
                name="export-speed"
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <span className="block text-sm font-medium text-white">{option.label}</span>
              <span className="block text-xs text-gray-400 mt-1">{option.hint}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
