import { COMPONENT_BOUNDS, type ColorKey, type ComponentKey, type LabInput } from "./types";

interface ColorFieldSetProps {
  colorKey: ColorKey;
  title: string;
  hint: string;
  values: LabInput;
  errors: Partial<Record<`${ColorKey}.${ComponentKey}`, string>>;
  disabled: boolean;
  onChange: (color: ColorKey, comp: ComponentKey, value: string) => void;
}

const ORDER: ComponentKey[] = ["L", "a", "b"];

export function ColorFieldSet({
  colorKey,
  title,
  hint,
  values,
  errors,
  disabled,
  onChange,
}: ColorFieldSetProps) {
  return (
    <fieldset className="color-card" data-testid={`fieldset-${colorKey}`}>
      <legend>
        <strong>{title}</strong>
        <span className="hint">{hint}</span>
      </legend>
      <div className="fields">
        {ORDER.map((comp) => {
          const bound = COMPONENT_BOUNDS[comp];
          const fieldId = `${colorKey}.${comp}` as const;
          const msg = errors[fieldId];
          return (
            <label key={comp} className="field" htmlFor={fieldId}>
              <span className="field-label">
                {bound.greek}
                <small>
                  [{bound.min}, {bound.max}]
                </small>
              </span>
              <input
                id={fieldId}
                data-testid={fieldId}
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={Boolean(msg)}
                aria-describedby={msg ? `${fieldId}-error` : undefined}
                value={values[comp]}
                disabled={disabled}
                onChange={(e) => onChange(colorKey, comp, e.target.value)}
              />
              {msg && (
                <span
                  id={`${fieldId}-error`}
                  className="field-error"
                  data-testid={`${fieldId}-error`}
                  role="alert"
                >
                  {msg}
                </span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
