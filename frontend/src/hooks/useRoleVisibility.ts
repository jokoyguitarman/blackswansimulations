import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  canSee,
  getBlindSpots,
  getRoleDescription,
  type InformationType,
} from '@shared/roleVisibility';

/**
 * Hook to check information visibility based on user role
 */
export function useRoleVisibility() {
  const { user } = useAuth();

  const role = user?.role || 'trainer';

  const checkVisibility = useMemo(
    () => (informationType: InformationType) => {
      return canSee(role, informationType);
    },
    [role],
  );

  const blindSpots = useMemo(() => getBlindSpots(role), [role]);
  const roleDescription = useMemo(() => getRoleDescription(role), [role]);

  return {
    role,
    canSee: checkVisibility,
    blindSpots,
    roleDescription,
    isTrainer: role === 'trainer' || role === 'admin',
  };
}
