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
}

export interface ApiResponse<T> {
  data: T;
  error?: string;
}
