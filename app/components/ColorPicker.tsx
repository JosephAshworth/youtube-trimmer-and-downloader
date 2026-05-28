"use client";

import { THEME_COLORS, type ThemeColor } from "@/lib/utils";

interface ColorPickerProps {
  selected: ThemeColor;
  onChange: (color: ThemeColor) => void;
}

export default function ColorPicker({ selected, onChange }: ColorPickerProps) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-gray-400 uppercase tracking-wider">
        Theme Color
      </span>
      <div className="flex flex-wrap gap-2">
        {THEME_COLORS.map((color) => (
          <button
            key={color.name}
            type="button"
            title={color.name}
            onClick={() => onChange(color)}
            className="w-9 h-9 rounded-full transition-transform hover:scale-110 focus:outline-none"
            style={{
              backgroundColor: color.value,
              boxShadow:
                selected.name === color.name
                  ? `0 0 20px ${color.glow}, 0 0 40px ${color.glow}`
                  : `0 0 8px ${color.glow}`,
              border:
                selected.name === color.name
                  ? "2px solid white"
                  : "2px solid transparent",
            }}
            aria-label={`Select ${color.name} theme`}
          />
        ))}
      </div>
    </div>
  );
}
