import * as React from "react";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'secondary' | 'destructive' | 'outline';
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <span 
      ref={ref} 
      className={`badge badge-${variant} ${className || ''}`} 
      {...props} 
    />
  )
);
Badge.displayName = "Badge";