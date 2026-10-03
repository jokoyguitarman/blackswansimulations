export type UserRole =
  | 'defence_liaison'
  | 'police_commander'
  | 'public_information_officer'
  | 'health_director'
  | 'civil_government'
  | 'utility_manager'
  | 'intelligence_analyst'
  | 'ngo_liaison'
  | 'participant'
  | 'trainer'
  | 'admin';

export interface SessionUser {
  id: string;
  email?: string;
  role: UserRole;
  agency?: string;
  displayName?: string;
  /**
   * Must send their signed Consultant Agreement before using the app. Decided by the server
   * (GET /api/profile); until they have submitted, only the application form is open to them.
   */
  contractRequired?: boolean;
}

export interface ApiResponse<T> {
  data: T;
  error?: string;
}
