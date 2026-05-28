 "use client";

 import { useRef, useState } from "react";
 import {
   getMinimumGap,
   msToTimeParts,
   range,
   timePartsToMs,
   type TimeParts,
 } from "@/lib/utils";

 interface TimeInputsProps {
   label: string;
   durationMs: number;
   valueMs: number;
   maxMs?: number;
   minMs?: number;
   onUpdate: (ms: number) => void;
   accentColor?: string;
 }

 function TimeDropdownGroup({
   label,
   durationMs,
   valueMs,
   maxMs,
   minMs = 0,
   onUpdate,
   accentColor,
 }: TimeInputsProps) {
   const maxHours = Math.floor(durationMs / 3600000);
   const effectiveMaxMs = maxMs ?? durationMs;
   const effectiveMinMs = minMs;

   const [draft, setDraft] = useState<TimeParts>(() => msToTimeParts(valueMs));
   const [prevValueMs, setPrevValueMs] = useState(valueMs);
  const [showWarning, setShowWarning] = useState(false);
  const warningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

   if (valueMs !== prevValueMs) {
     setPrevValueMs(valueMs);
     setDraft(msToTimeParts(valueMs));
   }

   const getMaxForParts = (current: TimeParts): TimeParts => {
     const maxParts = msToTimeParts(effectiveMaxMs);
     return {
       hours: Math.min(maxParts.hours, maxHours),
       minutes: current.hours === maxParts.hours ? maxParts.minutes : 59,
       seconds:
         current.hours === maxParts.hours && current.minutes === maxParts.minutes
           ? maxParts.seconds
           : 59,
       milliseconds:
         current.hours === maxParts.hours &&
         current.minutes === maxParts.minutes &&
         current.seconds === maxParts.seconds
           ? maxParts.milliseconds
           : 999,
     };
   };

   const getMinForParts = (current: TimeParts): TimeParts => {
     const minParts = msToTimeParts(effectiveMinMs);
     return {
       hours: minParts.hours,
       minutes: current.hours === minParts.hours ? minParts.minutes : 0,
       seconds:
         current.hours === minParts.hours && current.minutes === minParts.minutes
           ? minParts.seconds
           : 0,
       milliseconds:
         current.hours === minParts.hours &&
         current.minutes === minParts.minutes &&
         current.seconds === minParts.seconds
           ? minParts.milliseconds
           : 0,
     };
   };

   const maxLimits = getMaxForParts(draft);
   const minLimits = getMinForParts(draft);

  const commitUpdate = (requested: number) => {
    const clamped = Math.min(Math.max(requested, effectiveMinMs), effectiveMaxMs);
    if (requested !== clamped) {
      setShowWarning(true);
      if (warningTimeoutRef.current) {
        clearTimeout(warningTimeoutRef.current);
      }
      warningTimeoutRef.current = setTimeout(() => {
        setShowWarning(false);
      }, 2000);
    }
    onUpdate(clamped);
  };

  const handleChange = (field: keyof TimeParts, val: number) => {
    const next = { ...draft, [field]: val };
    const ms = timePartsToMs(next);
    if (ms > effectiveMaxMs) {
      const clampedParts = msToTimeParts(effectiveMaxMs);
      setDraft(clampedParts);
      commitUpdate(timePartsToMs(clampedParts));
      return;
    }
    if (ms < effectiveMinMs) {
      const clampedParts = msToTimeParts(effectiveMinMs);
      setDraft(clampedParts);
      commitUpdate(timePartsToMs(clampedParts));
      return;
    }
    setDraft(next);
    commitUpdate(ms);
  };

   return (
     <div className="flex flex-col gap-3">
       <span
         className="text-sm font-semibold uppercase tracking-wider"
         style={{ color: accentColor ?? "var(--accent)" }}
       >
         {label}
       </span>
       <div className="flex flex-wrap items-end gap-2">
         <div className="flex flex-col gap-1">
           <label className="text-xs text-gray-400">Hours</label>
           <select
             className="select-glow"
             value={draft.hours}
             onChange={(e) => handleChange("hours", Number(e.target.value))}
           >
             {range(minLimits.hours, maxLimits.hours).map((h) => (
               <option key={h} value={h}>
                 {h}
               </option>
             ))}
           </select>
         </div>
         <div className="flex flex-col gap-1">
           <label className="text-xs text-gray-400">Min</label>
           <select
             className="select-glow"
             value={draft.minutes}
             onChange={(e) => handleChange("minutes", Number(e.target.value))}
           >
             {range(minLimits.minutes, maxLimits.minutes).map((m) => (
               <option key={m} value={m}>
                 {m.toString().padStart(2, "0")}
               </option>
             ))}
           </select>
         </div>
         <div className="flex flex-col gap-1">
           <label className="text-xs text-gray-400">Sec</label>
           <select
             className="select-glow"
             value={draft.seconds}
             onChange={(e) => handleChange("seconds", Number(e.target.value))}
           >
             {range(minLimits.seconds, maxLimits.seconds).map((s) => (
               <option key={s} value={s}>
                 {s.toString().padStart(2, "0")}
               </option>
             ))}
           </select>
         </div>
         <div className="flex flex-col gap-1">
           <label className="text-xs text-gray-400">Ms</label>
           <select
             className="select-glow"
             value={draft.milliseconds}
             onChange={(e) => handleChange("milliseconds", Number(e.target.value))}
           >
             {range(minLimits.milliseconds, maxLimits.milliseconds).map((ms) => (
               <option key={ms} value={ms}>
                 {ms.toString().padStart(3, "0")}
               </option>
             ))}
           </select>
         </div>
       </div>
       {showWarning && (
         <p className="text-xs text-red-400">
           Minimum gap is 3 seconds. Adjusted automatically.
         </p>
       )}
     </div>
   );
 }

 interface TimeInputsPanelProps {
   durationMs: number;
   startMs: number;
   endMs: number;
   onStartUpdate: (ms: number) => void;
   onEndUpdate: (ms: number) => void;
 }

 export default function TimeInputs({
   durationMs,
   startMs,
   endMs,
   onStartUpdate,
   onEndUpdate,
 }: TimeInputsPanelProps) {
   const minGap = getMinimumGap(durationMs);
   const startMax = Math.max(endMs - minGap, 0);
   const endMin = Math.min(startMs + minGap, durationMs);

   return (
     <div className="glass-panel p-5 flex flex-col gap-6">
       <p className="text-xs text-gray-400">
         Minimum gap: 3 seconds between start and end.
       </p>
       <TimeDropdownGroup
         label="Start Time"
         durationMs={durationMs}
         valueMs={startMs}
         maxMs={startMax}
         minMs={0}
         onUpdate={onStartUpdate}
         accentColor="#00ff88"
       />
       <div className="border-t border-white/10" />
       <TimeDropdownGroup
         label="End Time"
         durationMs={durationMs}
         valueMs={endMs}
         maxMs={durationMs}
         minMs={endMin}
         onUpdate={onEndUpdate}
         accentColor="#ff0040"
       />
     </div>
   );
 }
