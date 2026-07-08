import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";

export interface CompletionInputOption {
  key: string;
}

interface CompletionInputProps<T extends CompletionInputOption> {
  value: string;
  onValueChange: (value: string) => void;
  options: T[];
  listId: string;
  placeholder: string;
  optionActiveClassName: string;
  onSubmit: () => void;
  onSelect: (option: T) => void;
  onFocusInput?: () => void;
  onBlurInput?: () => void;
  leading?: (state: { focused: boolean; hasValue: boolean }) => ReactNode;
  trailing?: ReactNode;
  autoFocus?: boolean;
  disabled?: boolean;
  inputClassName?: string;
  containerClassName?: string;
  valueActiveClassName?: string;
  renderOption: (option: T, state: { active: boolean; id: string }) => ReactNode;
}

export function CompletionInput<T extends CompletionInputOption>({
  value,
  onValueChange,
  options,
  listId,
  placeholder,
  optionActiveClassName,
  onSubmit,
  onSelect,
  onFocusInput,
  onBlurInput,
  leading,
  trailing,
  autoFocus,
  disabled,
  inputClassName,
  containerClassName,
  valueActiveClassName,
  renderOption,
}: CompletionInputProps<T>) {
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const hasValue = value.trim().length > 0;
  const showOptions = focused && hasValue && options.length > 0;
  const activeOptionId = useMemo(() => {
    if (!showOptions || activeIndex < 0 || activeIndex >= options.length) return undefined;
    return `${listId}-${activeIndex}`;
  }, [activeIndex, listId, options.length, showOptions]);

  useEffect(() => {
    setActiveIndex((current) => (current >= options.length ? -1 : current));
  }, [options.length]);

  const closeOptions = () => {
    setFocused(false);
    setActiveIndex(-1);
    onBlurInput?.();
  };

  return (
    <div className="relative min-w-0 flex-1">
      <div
        className={cn(
          "flex h-12 items-center gap-3 rounded-[16px] bg-white/[0.045] px-4 shadow-[0_10px_30px_rgba(0,0,0,0.12)] transition-[background-color,box-shadow]",
          focused && "bg-white/[0.07] shadow-[0_18px_42px_rgba(0,0,0,0.18)]",
          hasValue && valueActiveClassName,
          containerClassName
        )}
      >
        {leading?.({ focused, hasValue })}
        <input
          autoFocus={autoFocus}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            onValueChange(event.target.value);
            setFocused(true);
            setActiveIndex(-1);
          }}
          onFocus={() => {
            setFocused(true);
            setActiveIndex(-1);
            onFocusInput?.();
          }}
          onBlur={() => window.setTimeout(closeOptions, 120)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (showOptions && event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((current) => (current < 0 ? 0 : (current + 1) % options.length));
              return;
            }
            if (showOptions && event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) =>
                current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length
              );
              return;
            }
            if (showOptions && event.key === "Escape") {
              event.preventDefault();
              closeOptions();
              return;
            }
            if (event.key === "Enter") {
              if (showOptions && activeIndex >= 0 && options[activeIndex]) {
                event.preventDefault();
                onSelect(options[activeIndex]);
                closeOptions();
                return;
              }
              closeOptions();
              onSubmit();
            }
          }}
          placeholder={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showOptions}
          aria-controls={showOptions ? listId : undefined}
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          spellCheck={false}
          className={cn(
            "completion-input min-w-0 flex-1 bg-transparent text-[0.95rem] font-medium text-text outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0 placeholder:text-text-muted/60",
            inputClassName
          )}
        />
        {trailing}
      </div>

      <AnimatePresence initial={false}>
        {showOptions && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.99 }}
            transition={{ type: "spring", duration: 0.22, bounce: 0 }}
            className="absolute left-0 right-0 top-[calc(100%+8px)] z-40 overflow-hidden rounded-[16px] bg-surface-solid/98 shadow-[0_24px_68px_rgba(0,0,0,0.32),0_0_0_1px_var(--color-border)] backdrop-blur-xl"
            id={listId}
            role="listbox"
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className="py-1.5">
              {options.map((option, index) => {
                const active = index === activeIndex;
                const id = `${listId}-${index}`;
                return (
                  <button
                    id={id}
                    key={option.key}
                    type="button"
                    role="option"
                    onClick={() => {
                      onSelect(option);
                      closeOptions();
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    aria-selected={active}
                    className={cn(
                      "completion-option group flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-[background-color,color] focus:outline-none focus-visible:outline-none focus-visible:ring-0",
                      active ? optionActiveClassName : "hover:bg-surface-raised"
                    )}
                  >
                    {renderOption(option, { active, id })}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
