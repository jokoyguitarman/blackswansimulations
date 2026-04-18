import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const DEBOUNCE_MS = 400;
const MIN_QUERY_LEN = 3;

export interface PickedLocation {
  lat: number;
  lng: number;
  display_name: string;
}

interface NominatimResult {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
}

interface Props {
  onLocationChange: (loc: PickedLocation | null) => void;
  initialLocation?: PickedLocation | null;
}

const COUNTRIES: [string, string][] = [
  ['', 'All Countries'],
  ['AF', 'Afghanistan'],
  ['AL', 'Albania'],
  ['DZ', 'Algeria'],
  ['AR', 'Argentina'],
  ['AU', 'Australia'],
  ['AT', 'Austria'],
  ['BD', 'Bangladesh'],
  ['BE', 'Belgium'],
  ['BR', 'Brazil'],
  ['BN', 'Brunei'],
  ['KH', 'Cambodia'],
  ['CA', 'Canada'],
  ['CN', 'China'],
  ['CO', 'Colombia'],
  ['CZ', 'Czech Republic'],
  ['DK', 'Denmark'],
  ['EG', 'Egypt'],
  ['FI', 'Finland'],
  ['FR', 'France'],
  ['DE', 'Germany'],
  ['GR', 'Greece'],
  ['HK', 'Hong Kong'],
  ['HU', 'Hungary'],
  ['IN', 'India'],
  ['ID', 'Indonesia'],
  ['IQ', 'Iraq'],
  ['IE', 'Ireland'],
  ['IL', 'Israel'],
  ['IT', 'Italy'],
  ['JP', 'Japan'],
  ['JO', 'Jordan'],
  ['KZ', 'Kazakhstan'],
  ['KE', 'Kenya'],
  ['KR', 'South Korea'],
  ['KW', 'Kuwait'],
  ['LA', 'Laos'],
  ['LB', 'Lebanon'],
  ['MY', 'Malaysia'],
  ['MX', 'Mexico'],
  ['MM', 'Myanmar'],
  ['NL', 'Netherlands'],
  ['NZ', 'New Zealand'],
  ['NG', 'Nigeria'],
  ['NO', 'Norway'],
  ['PK', 'Pakistan'],
  ['PH', 'Philippines'],
  ['PL', 'Poland'],
  ['PT', 'Portugal'],
  ['QA', 'Qatar'],
  ['RO', 'Romania'],
  ['RU', 'Russia'],
  ['SA', 'Saudi Arabia'],
  ['SG', 'Singapore'],
  ['ZA', 'South Africa'],
  ['ES', 'Spain'],
  ['LK', 'Sri Lanka'],
  ['SE', 'Sweden'],
  ['CH', 'Switzerland'],
  ['TW', 'Taiwan'],
  ['TH', 'Thailand'],
  ['TR', 'Turkey'],
  ['AE', 'UAE'],
  ['UA', 'Ukraine'],
  ['GB', 'United Kingdom'],
  ['US', 'United States'],
  ['VN', 'Vietnam'],
];

const markerIcon = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

function MapClickHandler({ onMapClick }: { onMapClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FlyToLocation({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  const lastFlown = useRef<string>('');

  useEffect(() => {
    const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    if (key !== lastFlown.current) {
      lastFlown.current = key;
      map.flyTo([lat, lng], 16, { duration: 1.2 });
    }
  }, [lat, lng, map]);

  return null;
}

export function LocationPicker({ onLocationChange, initialLocation }: Props) {
  const [query, setQuery] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [picked, setPicked] = useState<PickedLocation | null>(initialLocation ?? null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const mapCenter = useMemo<[number, number]>(
    () => (picked ? [picked.lat, picked.lng] : [20, 0]),
    [picked],
  );
  const mapZoom = picked ? 16 : 2;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const searchNominatim = useCallback(
    async (q: string) => {
      if (q.trim().length < MIN_QUERY_LEN) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        const params = new URLSearchParams({
          q: q.trim(),
          format: 'json',
          limit: '6',
        });
        if (countryCode) params.set('countrycodes', countryCode.toLowerCase());

        const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
          headers: { 'User-Agent': 'BlackSwanSimulations/1.0' },
        });
        if (!res.ok) {
          setResults([]);
          return;
        }
        const data = (await res.json()) as NominatimResult[];
        setResults(data);
        setShowDropdown(data.length > 0);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    },
    [countryCode],
  );

  const handleQueryChange = useCallback(
    (val: string) => {
      setQuery(val);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (val.trim().length < MIN_QUERY_LEN) {
        setResults([]);
        setShowDropdown(false);
        return;
      }
      debounceRef.current = setTimeout(() => searchNominatim(val), DEBOUNCE_MS);
    },
    [searchNominatim],
  );

  const selectResult = useCallback(
    (r: NominatimResult) => {
      const loc: PickedLocation = {
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        display_name: r.display_name,
      };
      setPicked(loc);
      onLocationChange(loc);
      setQuery(r.display_name);
      setShowDropdown(false);
    },
    [onLocationChange],
  );

  const handleMapClick = useCallback(
    (lat: number, lng: number) => {
      const loc: PickedLocation = {
        lat,
        lng,
        display_name: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      };
      setPicked(loc);
      onLocationChange(loc);
    },
    [onLocationChange],
  );

  const handleMarkerDrag = useCallback(
    (e: L.DragEndEvent) => {
      const latlng = (e.target as L.Marker).getLatLng();
      const loc: PickedLocation = {
        lat: latlng.lat,
        lng: latlng.lng,
        display_name: `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`,
      };
      setPicked(loc);
      onLocationChange(loc);
    },
    [onLocationChange],
  );

  const handleGps = useCallback(() => {
    if (!navigator.geolocation) {
      setGpsError('Geolocation not supported by browser');
      return;
    }
    setGpsLoading(true);
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc: PickedLocation = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          display_name: `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`,
        };
        setPicked(loc);
        onLocationChange(loc);
        setGpsLoading(false);
      },
      (err) => {
        setGpsError(err.message);
        setGpsLoading(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, [onLocationChange]);

  // Auto-geolocate on mount and detect country
  const autoGeoTriggered = useRef(false);
  useEffect(() => {
    if (autoGeoTriggered.current || picked) return;
    autoGeoTriggered.current = true;
    if (!navigator.geolocation) return;
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const loc: PickedLocation = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          display_name: `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`,
        };
        setPicked(loc);
        onLocationChange(loc);
        setGpsLoading(false);

        // Reverse geocode to detect country
        try {
          const resp = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}&format=json&zoom=3`,
            { headers: { 'User-Agent': 'BlackSwanSimulations/1.0' } },
          );
          if (resp.ok) {
            const data = await resp.json();
            const cc = data.address?.country_code?.toUpperCase();
            if (cc && COUNTRIES.some(([code]) => code === cc)) {
              setCountryCode(cc);
            }
            if (data.display_name) {
              const updatedLoc = { ...loc, display_name: data.display_name };
              setPicked(updatedLoc);
              onLocationChange(updatedLoc);
            }
          }
        } catch {
          /* ignore reverse geocode failure */
        }
      },
      () => {
        setGpsLoading(false);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  }, [picked, onLocationChange]);

  const handleClear = useCallback(() => {
    setPicked(null);
    onLocationChange(null);
    setQuery('');
    setResults([]);
  }, [onLocationChange]);

  const markerEventHandlers = useMemo(() => ({ dragend: handleMarkerDrag }), [handleMarkerDrag]);

  return (
    <div className="space-y-3">
      {/* Search row */}
      <div className="flex gap-2 items-end flex-wrap">
        <div className="flex-shrink-0">
          <label className="text-[10px] terminal-text text-robotic-yellow/50 uppercase block mb-1">
            Country Filter
          </label>
          <select
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            className="px-2 py-[6px] bg-black/50 border border-robotic-yellow/30 text-robotic-yellow text-xs terminal-text w-40"
          >
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 relative" ref={dropdownRef}>
          <label className="text-[10px] terminal-text text-robotic-yellow/50 uppercase block mb-1">
            Search Location / Building
          </label>
          <input
            type="text"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onFocus={() => results.length > 0 && setShowDropdown(true)}
            placeholder="Type a location, venue, or building name..."
            className="w-full px-3 py-[6px] bg-black/50 border border-robotic-yellow/30 text-robotic-yellow text-xs terminal-text placeholder:text-robotic-yellow/30"
          />
          {searching && (
            <span className="absolute right-2 top-[26px] text-[10px] terminal-text text-robotic-yellow/50">
              searching...
            </span>
          )}
          {showDropdown && results.length > 0 && (
            <div className="absolute z-[9999] w-full mt-1 bg-black border border-robotic-yellow/40 max-h-48 overflow-y-auto">
              {results.map((r) => (
                <button
                  key={r.place_id}
                  onClick={() => selectResult(r)}
                  className="w-full text-left px-3 py-2 text-xs terminal-text text-robotic-yellow/80 hover:bg-robotic-yellow/10 border-b border-robotic-yellow/10 last:border-b-0"
                >
                  {r.display_name}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={handleGps}
          disabled={gpsLoading}
          className="flex-shrink-0 px-3 py-[6px] text-xs terminal-text uppercase border border-robotic-yellow/30 text-robotic-yellow/70 hover:border-robotic-yellow/60 hover:text-robotic-yellow disabled:opacity-50 self-end"
          title="Use your current GPS location"
        >
          {gpsLoading ? 'LOCATING...' : 'USE MY LOCATION'}
        </button>

        {picked && (
          <button
            onClick={handleClear}
            className="flex-shrink-0 px-3 py-[6px] text-xs terminal-text uppercase border border-red-500/30 text-red-400/70 hover:border-red-500/60 hover:text-red-400 self-end"
          >
            CLEAR
          </button>
        )}
      </div>

      {gpsError && <p className="text-[10px] terminal-text text-red-400">{gpsError}</p>}

      {/* Selected location display */}
      {picked && (
        <div className="text-xs terminal-text text-robotic-yellow/80 flex gap-4">
          <span>
            Lat: <span className="text-robotic-yellow">{picked.lat.toFixed(6)}</span>
          </span>
          <span>
            Lng: <span className="text-robotic-yellow">{picked.lng.toFixed(6)}</span>
          </span>
          {picked.display_name && !picked.display_name.match(/^-?\d/) && (
            <span className="text-robotic-yellow/60 truncate max-w-[400px]">
              {picked.display_name}
            </span>
          )}
        </div>
      )}

      {/* Map */}
      <div className="border border-robotic-yellow/20" style={{ height: 300 }}>
        <MapContainer
          center={mapCenter}
          zoom={mapZoom}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            subdomains={['a', 'b', 'c']}
          />
          <MapClickHandler onMapClick={handleMapClick} />
          {picked && <FlyToLocation lat={picked.lat} lng={picked.lng} />}
          {picked && (
            <Marker
              position={[picked.lat, picked.lng]}
              icon={markerIcon}
              draggable
              eventHandlers={markerEventHandlers}
            />
          )}
        </MapContainer>
      </div>

      <p className="text-[10px] terminal-text text-robotic-yellow/40">
        Search for a location above, use GPS, or click/drag on the map to set the scenario centroid.
        This location will be used for OSM data fetching.
      </p>
    </div>
  );
}
