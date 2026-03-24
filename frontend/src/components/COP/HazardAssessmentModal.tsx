import { useState } from 'react';
import type { HazardData } from './HazardMarker';

interface HazardAssessmentModalProps {
  hazard: HazardData;
  onClose: () => void;
  onSubmitDecision: (hazardId: string, description: string) => void;
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
  onClose,
  onSubmitDecision,
}: HazardAssessmentModalProps) => {
  const [decision, setDecision] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!decision.trim()) return;
    setIsSubmitting(true);
    try {
      await onSubmitDecision(hazard.id, decision.trim());
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  const imageUrl = hazard.current_image_url || hazard.image_url;
  const properties = hazard.properties;

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-black/95 border border-robotic-yellow/40 rounded-lg max-w-xl w-full mx-4 max-h-[90vh] overflow-y-auto">
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

        {/* Decision Input */}
        <div className="px-4 py-3">
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
          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs terminal-text text-robotic-yellow/60 border border-robotic-yellow/20 rounded hover:border-robotic-yellow/40"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!decision.trim() || isSubmitting}
              className="px-4 py-1.5 text-xs terminal-text text-black bg-robotic-yellow rounded hover:bg-robotic-yellow/90 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
            >
              {isSubmitting ? 'Submitting...' : 'Submit Assessment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
