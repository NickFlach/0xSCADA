import { useState, useCallback } from 'react';

export interface ToastProps {
  id?: string;
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive' | 'success';
  duration?: number;
}

export interface Toast extends Required<Pick<ToastProps, 'id'>> {
  title?: string;
  description?: string;
  variant: 'default' | 'destructive' | 'success';
  duration: number;
}

let toastCount = 0;

/**
 * Simple toast notifications hook
 */
export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((props: ToastProps) => {
    const id = props.id || `toast-${++toastCount}`;
    const toast: Toast = {
      id,
      title: props.title,
      description: props.description,
      variant: props.variant || 'default',
      duration: props.duration || 5000,
    };

    setToasts((prev) => [...prev, toast]);

    // Auto dismiss
    if (toast.duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, toast.duration);
    }

    return id;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    setToasts([]);
  }, []);

  return {
    toasts,
    addToast,
    dismissToast,
    dismissAll,
  };
}

/**
 * Global toast function for imperative usage
 */
export const toast = {
  success: (props: Omit<ToastProps, 'variant'>) => console.log('Toast (success):', props),
  error: (props: Omit<ToastProps, 'variant'>) => console.log('Toast (error):', props),
  info: (props: Omit<ToastProps, 'variant'>) => console.log('Toast (info):', props),
};