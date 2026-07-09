import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';
import { CreateResourceRequestForm } from '../Forms/CreateResourceRequestForm';
import { useWebSocket } from '../../hooks/useWebSocket';

interface ResourceRequest {
  id: string;
  resource_type: string;
  quantity: number;
  from_agency: string;
  to_agency: string;
  status: string;
  conditions?: string;
  created_at: string;
  requester?: {
    full_name: string;
    agency_name: string;
  };
}

interface Resource {
  agency_name: string;
  resource_type: string;
  quantity: number;
  available: number;
}

interface ResourceMarketplaceProps {
  sessionId: string;
}

export const ResourceMarketplace = ({ sessionId }: ResourceMarketplaceProps) => {
  const { user } = useAuth();
  const [resources, setResources] = useState<Resource[]>([]);
  const [requests, setRequests] = useState<ResourceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRequestModal, setShowRequestModal] = useState(false);

  // Initial load
  useEffect(() => {
    loadResources();
  }, [sessionId]);

  // WebSocket subscription for real-time resource updates
  useWebSocket({
    sessionId,
    eventTypes: [
      'resource.requested',
      'resource.countered',
      'resource.approved',
      'resource.rejected',
      'resource.transferred',
    ],
    onEvent: async () => {
      // Reload resources when any resource event occurs
      await loadResources();
    },
    enabled: !!sessionId,
  });

  const loadResources = async () => {
    try {
      const result = await api.resources.get(sessionId);
      setResources((result.data.resources || []) as Resource[]);
      setRequests((result.data.requests || []) as ResourceRequest[]);
    } catch (error) {
      console.error('Failed to load resources:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleApproveRequest = async (requestId: string) => {
    try {
      await api.resources.updateRequest(requestId, { status: 'approved' });
      // Don't reload - WebSocket will handle the update
    } catch (error) {
      console.error('Failed to approve request:', error);
      alert('Failed to approve request');
    }
  };

  const handleRejectRequest = async (requestId: string) => {
    try {
      await api.resources.updateRequest(requestId, { status: 'rejected' });
      // Don't reload - WebSocket will handle the update
    } catch (error) {
      console.error('Failed to reject request:', error);
      alert('Failed to reject request');
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'approved':
        return 'bg-accent/10 text-ink border-border';
      case 'rejected':
        return 'bg-accent/10 text-accent border-accent';
      case 'pending':
        return 'bg-surface-2 text-muted border-border';
      default:
        return 'bg-surface-2 text-muted border-border';
    }
  };

  const myAgencyResources = resources.filter((r) => r.agency_name === user?.agency);
  const incomingRequests = requests.filter(
    (r) => r.from_agency === user?.agency && r.status === 'pending',
  );
  const outgoingRequests = requests.filter((r) => r.to_agency === user?.agency);

  if (loading) {
    return (
      <div className="military-border p-6">
        <div className="text-center">
          <div className="text-sm terminal-text text-muted animate-pulse">Loading resources…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* My Resources */}
      <div className="military-border p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg terminal-text">My agency resources</h3>
          <button
            onClick={() => setShowRequestModal(true)}
            className="military-button px-4 py-2 text-sm"
          >
            Request resources
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {myAgencyResources.map((resource, idx) => (
            <div key={idx} className="military-border p-4">
              <div className="text-sm terminal-text mb-2">{resource.resource_type}</div>
              <div className="text-xs terminal-text text-muted">
                Total: {resource.quantity} | Available: {resource.available}
              </div>
            </div>
          ))}
          {myAgencyResources.length === 0 && (
            <p className="text-sm terminal-text text-muted col-span-full">No resources assigned</p>
          )}
        </div>
      </div>

      {/* Incoming Requests */}
      {incomingRequests.length > 0 && (
        <div className="military-border p-6">
          <h3 className="text-lg terminal-text mb-4">Requests for my resources</h3>
          <div className="space-y-3">
            {incomingRequests.map((request) => (
              <div key={request.id} className="military-border p-4">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h4 className="text-sm terminal-text font-semibold">
                      {request.quantity}x {request.resource_type}
                    </h4>
                    <p className="text-xs terminal-text text-muted">
                      From: {request.to_agency} • Requested by:{' '}
                      {request.requester?.full_name || 'Unknown'}
                    </p>
                    {request.conditions && (
                      <p className="text-xs terminal-text text-muted mt-1">
                        Conditions:{' '}
                        {typeof request.conditions === 'string'
                          ? request.conditions
                          : JSON.stringify(request.conditions)}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleApproveRequest(request.id)}
                      className="px-3 py-1 text-xs terminal-text border border-border text-ink hover:bg-accent/10"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleRejectRequest(request.id)}
                      className="px-3 py-1 text-xs terminal-text border border-accent text-accent hover:bg-accent/10"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Outgoing Requests */}
      {outgoingRequests.length > 0 && (
        <div className="military-border p-6">
          <h3 className="text-lg terminal-text mb-4">My resource requests</h3>
          <div className="space-y-3">
            {outgoingRequests.map((request) => (
              <div key={request.id} className="military-border p-4">
                <div className="flex justify-between items-start">
                  <div>
                    <h4 className="text-sm terminal-text font-semibold">
                      {request.quantity}x {request.resource_type}
                    </h4>
                    <p className="text-xs terminal-text text-muted">From: {request.from_agency}</p>
                  </div>
                  <span
                    className={`text-xs terminal-text px-2 py-1 border ${getStatusColor(request.status)}`}
                  >
                    {request.status.toUpperCase()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Request Modal */}
      {showRequestModal && (
        <CreateResourceRequestForm
          sessionId={sessionId}
          onClose={() => setShowRequestModal(false)}
          onSuccess={loadResources}
        />
      )}
    </div>
  );
};
