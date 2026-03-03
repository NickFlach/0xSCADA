import * as React from "react";

export interface TooltipProps extends React.HTMLAttributes<HTMLDivElement> {}

export const Tooltip = React.forwardRef<HTMLDivElement, TooltipProps>(
  ({ className, children, ...props }, ref) => (
    <div ref={ref} className={`tooltip ${className || ''}`} {...props}>
      {children}
    </div>
  )
);
Tooltip.displayName = "Tooltip";

export interface TooltipContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={`tooltip-content ${className || ''}`} {...props} />
  )
);
TooltipContent.displayName = "TooltipContent";

export interface TooltipProviderProps extends React.HTMLAttributes<HTMLDivElement> {}

export const TooltipProvider: React.FC<TooltipProviderProps> = ({ children, ...props }) => (
  <div {...props}>
    {children}
  </div>
);

export interface TooltipTriggerProps extends React.HTMLAttributes<HTMLButtonElement> {}

export const TooltipTrigger = React.forwardRef<HTMLButtonElement, TooltipTriggerProps>(
  ({ className, ...props }, ref) => (
    <button ref={ref} className={`tooltip-trigger ${className || ''}`} {...props} />
  )
);
TooltipTrigger.displayName = "TooltipTrigger";