import { useState, useEffect } from 'react';

/**
 * Hook to detect if the device is mobile based on screen size
 */
export function useMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  return isMobile;
}

/**
 * Alias for useMobile for compatibility
 */
export const useIsMobile = useMobile;