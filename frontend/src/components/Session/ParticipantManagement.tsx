import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useRoleVisibility } from '../../hooks/useRoleVisibility';

interface Participant {
  user_id: string;
  role: string;
  user?: {
    id: string;
    full_name: string;
    email: string;
    role: string;
    agency_name: string;
  };
}

interface User {
  id: string;
  full_name: string;
  email: string;
  role: string;
  agency_name: string;
}

interface ParticipantManagementProps {
  sessionId: string;
  participants: Participant[];
  onUpdate: () => void;
}

const AVAILABLE_ROLES = [
  { value: 'defence', label: 'Defence' },
  { value: 'health', label: 'Health Services' },
  { value: 'civil', label: 'Civil Government' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'intelligence', label: 'Intelligence' },
  { value: 'ngo', label: 'NGO' },
  { value: 'public_information_officer', label: 'Public Information Officer' },
  { value: 'police_commander', label: 'Police Commander' },
  { value: 'legal_oversight', label: 'Legal Oversight' },
];

export const ParticipantManagement = ({
  sessionId,
  participants,
  onUpdate,
}: ParticipantManagementProps) => {
  const { isTrainer } = useRoleVisibility();
  const [showAddModal, setShowAddModal] = useState(false);
  const [modalMode, setModalMode] = useState<'existing' | 'email'>('existing');
  const [availableUsers, setAvailableUsers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [inviteEmail, setInviteEmail] = useState<string>('');
  const [selectedRole, setSelectedRole] = useState<string>('defence');
  const [loading, setLoading] = useState(false);
  const [processingInvitations, setProcessingInvitations] = useState(false);

  useEffect(() => {
    if (showAddModal && isTrainer) {
      loadAvailableUsers();
    }
  }, [showAddModal, isTrainer]);

  const loadAvailableUsers = async () => {
    try {
      const result = await api.sessions.getAvailableUsers();
      setAvailableUsers((result.data || []) as User[]);
    } catch (error) {
      console.error('Failed to load users:', error);
      alert('Failed to load available users');
    }
  };

  const handleAddParticipant = async () => {
    if (!selectedUserId || !selectedRole) {
      alert('Please select a user and role');
      return;
    }

    setLoading(true);
    try {
      await api.sessions.addParticipant(sessionId, selectedUserId, selectedRole);
      setShowAddModal(false);
      setSelectedUserId('');
      setSelectedRole('defence');
      setModalMode('existing');
      onUpdate();
    } catch (error) {
      console.error('Failed to add participant:', error);
      alert('Failed to add participant');
    } finally {
      setLoading(false);
    }
  };

  const handleInviteByEmail = async () => {
    if (!inviteEmail || !selectedRole) {
      alert('Please enter an email address and select a role');
      return;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(inviteEmail)) {
      alert('Please enter a valid email address');
      return;
    }

    setLoading(true);
    try {
      const result = await api.sessions.inviteByEmail(sessionId, inviteEmail, selectedRole);
      setShowAddModal(false);
      setInviteEmail('');
      setSelectedRole('defence');
      setModalMode('existing');
      alert(
        result.isNewUser
          ? `Invitation sent to ${inviteEmail}. They will receive a signup link via email.`
          : `Invitation sent to ${inviteEmail}. They are already registered.`,
      );
      onUpdate();
    } catch (error) {
      console.error('Failed to invite by email:', error);
      alert(error instanceof Error ? error.message : 'Failed to send invitation');
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveParticipant = async (userId: string) => {
    if (!confirm('Remove this participant from the session?')) {
      return;
    }

    try {
      await api.sessions.removeParticipant(sessionId, userId);
      onUpdate();
    } catch (error) {
      console.error('Failed to remove participant:', error);
      alert('Failed to remove participant');
    }
  };

  const handleProcessAllInvitations = async () => {
    if (
      !confirm(
        'Process all pending invitations for this session? This will add any users who have signed up and were invited.',
      )
    ) {
      return;
    }

    setProcessingInvitations(true);
    try {
      const result = await api.sessions.processAllInvitations(sessionId);
      let message = `Processed ${result.data.processed} invitations. ${result.data.totalInvitations} total invitations found.`;

      if (result.data.skipped && result.data.skipped.length > 0) {
        message += `\n\nSkipped ${result.data.skipped.length} invitations:\n`;
        result.data.skipped.forEach((skip: { email: string; reason: string }) => {
          message += `- ${skip.email}: ${skip.reason}\n`;
        });
      }

      alert(message);
      onUpdate();
    } catch (error) {
      console.error('Failed to process invitations:', error);
      alert('Failed to process invitations');
    } finally {
      setProcessingInvitations(false);
    }
  };

  if (!isTrainer) {
    return null;
  }

  // Filter out users already in the session
  const participantUserIds = new Set(participants.map((p) => p.user_id));
  const availableToAdd = availableUsers.filter((user) => !participantUserIds.has(user.id));

  return (
    <div className="military-border p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg terminal-text uppercase">[PARTICIPANTS] Role Assignments</h3>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => {
              setModalMode('existing');
              setShowAddModal(true);
            }}
            className="military-button px-4 py-2 text-sm"
          >
            [ADD_USER]
          </button>
          <button
            onClick={() => {
              setModalMode('email');
              setShowAddModal(true);
            }}
            className="military-button px-4 py-2 text-sm border-robotic-yellow text-robotic-yellow"
          >
            [INVITE_BY_EMAIL]
          </button>
          <button
            onClick={handleProcessAllInvitations}
            disabled={processingInvitations}
            className="military-button px-4 py-2 text-sm border-robotic-green text-robotic-green disabled:opacity-50"
          >
            {processingInvitations ? '[PROCESSING...]' : '[PROCESS_INVITATIONS]'}
          </button>
        </div>
      </div>

      {participants.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-sm terminal-text text-robotic-yellow/50">[NO_PARTICIPANTS]</p>
          <p className="text-xs terminal-text text-robotic-yellow/30 mt-2">
            Add participants to assign roles for this session
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {participants.map((participant) => (
            <div
              key={participant.user_id}
              className="military-border p-4 bg-robotic-gray-300 flex justify-between items-center"
            >
              <div className="flex-1">
                <div className="text-sm terminal-text font-semibold">
                  {participant.user?.full_name || 'Unknown User'}
                </div>
                <div className="text-xs terminal-text text-robotic-yellow/70 mt-1">
                  [{participant.role.toUpperCase().replace('_', ' ')}]
                  {participant.user?.email && ` • ${participant.user.email}`}
                  {participant.user?.agency_name && ` • ${participant.user.agency_name}`}
                </div>
              </div>
              <button
                onClick={() => handleRemoveParticipant(participant.user_id)}
                className="px-3 py-1 text-xs terminal-text border border-robotic-orange text-robotic-orange hover:bg-robotic-orange/10"
              >
                [REMOVE]
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add Participant Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="military-border bg-robotic-gray-300 p-8 max-w-md w-full">
            <h3 className="text-xl terminal-text uppercase mb-4">
              {modalMode === 'email' ? '[INVITE_BY_EMAIL]' : '[ADD_PARTICIPANT]'}
            </h3>

            {/* Mode Toggle */}
            <div className="flex gap-2 mb-4 border-b border-robotic-yellow/30 pb-4">
              <button
                onClick={() => setModalMode('existing')}
                className={`px-4 py-2 text-xs terminal-text ${
                  modalMode === 'existing'
                    ? 'bg-robotic-yellow text-black'
                    : 'border border-robotic-yellow/50 text-robotic-yellow/70 hover:bg-robotic-yellow/10'
                }`}
              >
                [EXISTING_USER]
              </button>
              <button
                onClick={() => setModalMode('email')}
                className={`px-4 py-2 text-xs terminal-text ${
                  modalMode === 'email'
                    ? 'bg-robotic-yellow text-black'
                    : 'border border-robotic-yellow/50 text-robotic-yellow/70 hover:bg-robotic-yellow/10'
                }`}
              >
                [INVITE_BY_EMAIL]
              </button>
            </div>

            <div className="space-y-4">
              {modalMode === 'existing' ? (
                <>
                  <div>
                    <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                      [SELECT_USER]
                    </label>
                    <select
                      value={selectedUserId}
                      onChange={(e) => setSelectedUserId(e.target.value)}
                      className="w-full px-4 py-3 military-input terminal-text"
                    >
                      <option value="">-- Select a user --</option>
                      {availableToAdd.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.full_name} ({user.email}){' '}
                          {user.agency_name ? `- ${user.agency_name}` : ''}
                        </option>
                      ))}
                    </select>
                    {availableToAdd.length === 0 && (
                      <p className="text-xs terminal-text text-robotic-yellow/50 mt-2">
                        All users are already participants
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                      [EMAIL_ADDRESS]
                    </label>
                    <input
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="participant@example.com"
                      className="w-full px-4 py-3 military-input terminal-text"
                    />
                    <p className="text-xs terminal-text text-robotic-yellow/50 mt-2">
                      They will receive an email with a signup link if not registered
                    </p>
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase">
                  [ASSIGN_ROLE]
                </label>
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value)}
                  className="w-full px-4 py-3 military-input terminal-text"
                >
                  {AVAILABLE_ROLES.map((role) => (
                    <option key={role.value} value={role.value}>
                      {role.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-4 pt-4">
                <button
                  onClick={modalMode === 'email' ? handleInviteByEmail : handleAddParticipant}
                  disabled={
                    loading ||
                    (modalMode === 'existing' &&
                      (!selectedUserId || availableToAdd.length === 0)) ||
                    (modalMode === 'email' && !inviteEmail)
                  }
                  className="military-button px-6 py-3 flex-1 disabled:opacity-50"
                >
                  {loading
                    ? '[PROCESSING...]'
                    : modalMode === 'email'
                      ? '[SEND_INVITATION]'
                      : '[ADD]'}
                </button>
                <button
                  onClick={() => {
                    setShowAddModal(false);
                    setSelectedUserId('');
                    setInviteEmail('');
                    setSelectedRole('defence');
                    setModalMode('existing');
                  }}
                  className="military-button px-6 py-3 flex-1 border-robotic-orange text-robotic-orange"
                >
                  [CANCEL]
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
