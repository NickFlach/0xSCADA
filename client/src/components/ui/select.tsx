import * as React from "react";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={`select ${className || ''}`} {...props}>
      {children}
    </select>
  )
);
Select.displayName = "Select";

export interface SelectContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export const SelectContent = React.forwardRef<HTMLDivElement, SelectContentProps>(
  ({ className, children, ...props }, ref) => (
    <div ref={ref} className={`select-content ${className || ''}`} {...props}>
      {children}
    </div>
  )
);
SelectContent.displayName = "SelectContent";

export interface SelectItemProps extends React.OptionHTMLAttributes<HTMLOptionElement> {}

export const SelectItem = React.forwardRef<HTMLOptionElement, SelectItemProps>(
  ({ className, ...props }, ref) => (
    <option ref={ref} className={`select-item ${className || ''}`} {...props} />
  )
);
SelectItem.displayName = "SelectItem";

export interface SelectTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const SelectTrigger = React.forwardRef<HTMLButtonElement, SelectTriggerProps>(
  ({ className, ...props }, ref) => (
    <button ref={ref} className={`select-trigger ${className || ''}`} {...props} />
  )
);
SelectTrigger.displayName = "SelectTrigger";

export interface SelectValueProps extends React.HTMLAttributes<HTMLSpanElement> {}

export const SelectValue = React.forwardRef<HTMLSpanElement, SelectValueProps>(
  ({ className, ...props }, ref) => (
    <span ref={ref} className={`select-value ${className || ''}`} {...props} />
  )
);
SelectValue.displayName = "SelectValue";