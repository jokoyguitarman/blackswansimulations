import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
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

export const ParticipantManagement = ({
  sessionId,
  participants,
  onUpdate,
}: ParticipantManagementProps) => {
  const { isTrainer } = useRoleVisibility();
  const [showAddModal, setShowAddModal] = useState(false);
  const [modalMode, setModalMode] = useState<'existing' | 'email'>('existing');
  const [availableUsers, setAvailableUsers] = useState<User[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [inviteEmail, setInviteEmail] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [processingInvitations, setProcessingInvitations] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');

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

  const toggleUser = (userId: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleAddParticipants = async () => {
    if (selectedUserIds.size === 0) {
      alert('Please select at least one user');
      return;
    }

    setLoading(true);
    const defaultRole = 'defence';
    let successCount = 0;
    const errors: string[] = [];

    for (const userId of selectedUserIds) {
      try {
        await api.sessions.addParticipant(sessionId, userId, defaultRole);
        successCount++;
      } catch {
        const user = availableUsers.find((u) => u.id === userId);
        errors.push(user?.full_name ?? userId);
      }
    }

    setLoading(false);

    if (errors.length > 0) {
      alert(`Added ${successCount} user(s). Failed for: ${errors.join(', ')}`);
    }

    setShowAddModal(false);
    setSelectedUserIds(new Set());
    setSearchFilter('');
    setModalMode('existing');
    onUpdate();
  };

  const handleInviteByEmail = async () => {
    if (!inviteEmail) {
      alert('Please enter an email address');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(inviteEmail)) {
      alert('Please enter a valid email address');
      return;
    }

    setLoading(true);
    try {
      const result = await api.sessions.inviteByEmail(sessionId, inviteEmail, 'defence');
      setShowAddModal(false);
      setInviteEmail('');
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

      if ((result.data as any).skipped && (result.data as any).skipped.length > 0) {
        message += `\n\nSkipped ${(result.data as any).skipped.length} invitations:\n`;
        (result.data as any).skipped.forEach((skip: { email: string; reason: string }) => {
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
            className="military-button-outline px-4 py-2 text-sm border border-robotic-yellow text-robotic-yellow"
          >
            [INVITE_BY_EMAIL]
          </button>
          <button
            onClick={handleProcessAllInvitations}
            disabled={processingInvitations}
            className="military-button-outline px-4 py-2 text-sm border border-robotic-green text-robotic-green disabled:opacity-50"
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

      {/* Add Participant Modal — portal to body so fixed positioning works regardless of parent transforms */}
      {showAddModal &&
        createPortal(
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
            <div className="military-border bg-robotic-gray-300 p-8 max-w-lg w-full max-h-[85vh] flex flex-col">
              <h3 className="text-xl terminal-text uppercase mb-4">
                {modalMode === 'email' ? '[INVITE_BY_EMAIL]' : '[ADD_PARTICIPANTS]'}
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
                  [EXISTING_USERS]
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

              <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
                {modalMode === 'existing' ? (
                  <>
                    <div>
                      <input
                        type="text"
                        value={searchFilter}
                        onChange={(e) => setSearchFilter(e.target.value)}
                        placeholder="Search by name, email, or agency..."
                        className="w-full px-4 py-2 military-input terminal-text text-sm"
                      />
                    </div>

                    {selectedUserIds.size > 0 && (
                      <div className="text-xs terminal-text text-robotic-yellow/80">
                        {selectedUserIds.size} user{selectedUserIds.size > 1 ? 's' : ''} selected
                        <button
                          onClick={() => setSelectedUserIds(new Set())}
                          className="ml-2 text-robotic-orange hover:underline"
                        >
                          clear
                        </button>
                      </div>
                    )}

                    <div className="flex-1 overflow-y-auto space-y-1 min-h-0 max-h-[40vh] pr-1">
                      {availableToAdd.length === 0 ? (
                        <p className="text-xs terminal-text text-robotic-yellow/50 text-center py-4">
                          All users are already participants
                        </p>
                      ) : (
                        (() => {
                          const query = searchFilter.toLowerCase();
                          const filtered = query
                            ? availableToAdd.filter(
                                (u) =>
                                  u.full_name.toLowerCase().includes(query) ||
                                  u.email.toLowerCase().includes(query) ||
                                  (u.agency_name ?? '').toLowerCase().includes(query),
                              )
                            : availableToAdd;
                          if (filtered.length === 0) {
                            return (
                              <p className="text-xs terminal-text text-robotic-yellow/50 text-center py-4">
                                No matching users
                              </p>
                            );
                          }
                          return filtered.map((user) => {
                            const isSelected = selectedUserIds.has(user.id);
                            return (
                              <button
                                key={user.id}
                                onClick={() => toggleUser(user.id)}
                                className={`w-full text-left px-3 py-2 rounded border text-xs terminal-text transition-colors ${
                                  isSelected
                                    ? 'border-robotic-yellow bg-robotic-yellow/15 text-robotic-yellow'
                                    : 'border-robotic-yellow/20 text-robotic-yellow/70 hover:border-robotic-yellow/40 hover:bg-robotic-yellow/5'
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <span
                                    className={`w-4 h-4 border rounded flex items-center justify-center flex-shrink-0 text-[10px] ${
                                      isSelected
                                        ? 'border-robotic-yellow bg-robotic-yellow text-black'
                                        : 'border-robotic-yellow/40'
                                    }`}
                                  >
                                    {isSelected ? '✓' : ''}
                                  </span>
                                  <div className="min-w-0">
                                    <div className="font-medium truncate">{user.full_name}</div>
                                    <div className="text-robotic-yellow/50 truncate">
                                      {user.email}
                                      {user.agency_name ? ` · ${user.agency_name}` : ''}
                                    </div>
                                  </div>
                                </div>
                              </button>
                            );
                          });
                        })()
                      )}
                    </div>

                    {availableToAdd.length > 0 && (
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={() =>
                            setSelectedUserIds(new Set(availableToAdd.map((u) => u.id)))
                          }
                          className="text-[10px] terminal-text text-robotic-yellow/60 hover:text-robotic-yellow underline"
                        >
                          Select all
                        </button>
                      </div>
                    )}
                  </>
                ) : (
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
                )}

                <div className="flex gap-4 pt-4 flex-shrink-0">
                  <button
                    onClick={modalMode === 'email' ? handleInviteByEmail : handleAddParticipants}
                    disabled={
                      loading ||
                      (modalMode === 'existing' && selectedUserIds.size === 0) ||
                      (modalMode === 'email' && !inviteEmail)
                    }
                    className="military-button px-6 py-3 flex-1 disabled:opacity-50"
                  >
                    {loading
                      ? `[ADDING ${selectedUserIds.size}...]`
                      : modalMode === 'email'
                        ? '[SEND_INVITATION]'
                        : `[ADD ${selectedUserIds.size > 0 ? selectedUserIds.size + ' ' : ''}USER${selectedUserIds.size !== 1 ? 'S' : ''}]`}
                  </button>
                  <button
                    onClick={() => {
                      setShowAddModal(false);
                      setSelectedUserIds(new Set());
                      setInviteEmail('');
                      setSearchFilter('');
                      setModalMode('existing');
                    }}
                    className="military-button-outline px-6 py-3 flex-1 border border-robotic-orange text-robotic-orange"
                  >
                    [CANCEL]
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};
