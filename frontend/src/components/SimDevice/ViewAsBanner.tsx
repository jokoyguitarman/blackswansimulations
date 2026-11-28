import React from 'react';
import { viewAsBannerText, type ViewAsPlayer } from '../../lib/viewAsRoster';
import { ViewAsSelect } from './ViewAsMenu';

/** Fixed staff banner. There is no "Act as" control; that belongs to the sandbox. */
export function ViewAsBanner({
  player,
  players,
  onSwitch,
  onExit,
}: {
  player: ViewAsPlayer;
  players: readonly ViewAsPlayer[];
  onSwitch: (userId: string) => void;
  onExit: () => void;
}) {
  return (
    <React.Fragment>
      <div
        role="status"
        className="fixed inset-x-0 top-0 z-[80] flex items-center justify-between gap-3 px-4 py-2 text-sm"
        style={{ backgroundColor: '#1E3A5F', color: '#fff' }}
      >
        <span>{viewAsBannerText(player.name, player.team)}</span>
        <div className="flex items-center gap-2">
          <ViewAsSelect
            label="Switch player"
            players={players}
            value={player.userId}
            onChange={onSwitch}
          />
          <button
            type="button"
            onClick={onExit}
            className="text-[11px] font-semibold px-3 py-1.5 rounded-lg"
            style={{ backgroundColor: '#FFFFFF', color: '#1E3A5F' }}
          >
            Exit
          </button>
        </div>
      </div>
    </React.Fragment>
  );
}
