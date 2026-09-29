"use client";
import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import { Calendar } from "./ui/calendar";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

// Keep local calendar components intact; converting to UTC here would shift dates.
export function DateTimePicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const date = value ? new Date(value) : undefined;
  const selected = date && !Number.isNaN(date.getTime()) ? date : undefined;
  return (
    <div className="date-time-picker">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            className="justify-start"
            aria-label="First run date"
          >
            <CalendarIcon data-icon="inline-start" />
            {selected
              ? selected.toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })
              : "Choose date"}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto p-0"
          align="start"
          aria-label="First run calendar"
        >
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected}
            autoFocus
            required
            onSelect={(day) => {
              if (!day) return;
              const pad = (n: number) => String(n).padStart(2, "0");
              onChange(
                `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${value.slice(11) || "09:00"}`,
              );
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <Input
        type="time"
        aria-label="First run time"
        value={value.slice(11)}
        required
        onChange={(e) => onChange(value.slice(0, 10) + "T" + e.target.value)}
      />
    </div>
  );
}
