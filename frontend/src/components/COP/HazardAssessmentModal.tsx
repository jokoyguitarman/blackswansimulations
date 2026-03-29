import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { HazardData } from './HazardMarker';
import { api } from '../../lib/api';

interface HazardAssessmentModalProps {
  hazard: HazardData;
  sessionId: string;
  teamName: string;
  onClose: () => void;
}

const PROPERTY_LABELS: Record<string, string> = {
  fire_class: 'Fire Class',
  size: 'Size',
  fuel_source: 'Fuel Source',
  adjacent_risks: 'Adjacent Risks',
  wind_exposure: 'Wind Exposure',
  casualties_visible: 'Casualties Visible',
  access_blocked: 'Access Blocked',
  chemical_type: 'Chemical Type',
  structural_integrity: 'Structural Integrity',
  ventilation: 'Ventilation',
  gas_type: 'Gas Type',
  concentration: 'Concentration',
  water_level: 'Water Level',
  voltage: 'Voltage',
};

export const HazardAssessmentModal = ({
  hazard,
  sessionId,
  teamName,
  onClose,
}: HazardAssessmentModalProps) => {
  const [decision, setDecision] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleSubmit = async () => {
    if (!decision.trim()) return;
    setIsSubmitting(true);
    setResult(null);
    try {
      const createRes = await api.decisions.create({
        session_id: sessionId,
        description: `[Hazard Response: ${hazard.hazard_type.replace(/_/g, ' ')}] ${decision.trim()}`,
        team_name: teamName,
      });
      const created = (createRes as { data?: { id: string } })?.data;
      if (created?.id) {
        await api.decisions.execute(created.id);
        setResult({ success: true, message: 'Decision executed. Awaiting AI evaluation...' });
        setTimeout(onClose, 1500);
      } else {
        setResult({ success: false, message: 'Decision created but could not auto-execute.' });
      }
    } catch (err) {
      setResult({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to execute decision.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const imageUrl = hazard.current_image_url || hazard.image_url;
  const properties = hazard.properties;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-black/95 border border-robotic-yellow/40 rounded-lg max-w-xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-robotic-yellow/20">
          <div>
            <h2 className="text-sm font-semibold terminal-text text-robotic-yellow uppercase">
              Hazard Assessment
            </h2>
            <span className="text-xs terminal-text text-robotic-yellow/60 capitalize">
              {hazard.hazard_type.replace(/_/g, ' ')} — {hazard.status}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-robotic-yellow/50 hover:text-robotic-yellow text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Hazard Image */}
          {imageUrl && (
            <div className="w-full bg-gray-900 border-b border-robotic-yellow/20">
              <img
                src={imageUrl}
                alt={`${hazard.hazard_type} hazard`}
                className="w-full h-48 object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
          )}

          {/* Current description (from time-evolving sequence) */}
          {hazard.current_description && (
            <div className="px-4 py-2 bg-red-900/20 border-b border-red-500/20">
              <p className="text-xs terminal-text text-red-300">{hazard.current_description}</p>
            </div>
          )}

          {/* Properties */}
          <div className="px-4 py-3 border-b border-robotic-yellow/20">
            <h3 className="text-xs font-medium terminal-text text-robotic-yellow/70 mb-2 uppercase">
              Situation Details
            </h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {Object.entries(properties).map(([key, value]) => {
                if (value == null || value === '') return null;
                const label = PROPERTY_LABELS[key] ?? key.replace(/_/g, ' ');
                const displayValue =
                  typeof value === 'boolean'
                    ? value
                      ? 'Yes'
                      : 'No'
                    : Array.isArray(value)
                      ? value.join(', ')
                      : String(value);

                return (
                  <div key={key} className="text-xs terminal-text">
                    <span className="text-robotic-yellow/50 capitalize">{label}: </span>
                    <span className="text-robotic-yellow/90">{displayValue}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Decision Input — always visible at bottom */}
        <div className="px-4 py-3 shrink-0 border-t border-robotic-yellow/20">
          <h3 className="text-xs font-medium terminal-text text-robotic-yellow/70 mb-2 uppercase">
            Your Response
          </h3>
          <p className="text-xs terminal-text text-robotic-yellow/50 mb-2">
            Based on the hazard assessment above, describe how your team would respond to this{' '}
            {hazard.hazard_type.replace(/_/g, ' ')}.
          </p>
          <textarea
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            placeholder={`Describe your response to this ${hazard.hazard_type.replace(/_/g, ' ')}...`}
            className="w-full h-24 px-3 py-2 bg-black/50 border border-robotic-yellow/30 rounded text-xs terminal-text text-robotic-yellow placeholder-robotic-yellow/30 focus:border-robotic-yellow/60 focus:outline-none resize-none"
          />
          {result && (
            <div
              className={`mt-2 p-2 rounded text-xs terminal-text ${result.success ? 'bg-green-900/30 text-green-400 border border-green-500/30' : 'bg-red-900/30 text-red-400 border border-red-500/30'}`}
            >
              {result.message}
            </div>
          )}
          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs terminal-text text-robotic-yellow/60 border border-robotic-yellow/20 rounded hover:border-robotic-yellow/40"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!decision.trim() || isSubmitting || result?.success === true}
              className="px-4 py-1.5 text-xs font-mono font-medium bg-robotic-yellow rounded hover:bg-robotic-yellow/90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: '#0f0f0f' }}
            >
              {isSubmitting ? 'Executing...' : 'Execute Decision'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
