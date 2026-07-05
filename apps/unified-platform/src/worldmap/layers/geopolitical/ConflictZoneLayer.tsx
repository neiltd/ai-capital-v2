import { useMemo } from 'react'
import { Source, Layer, Marker } from 'react-map-gl/maplibre'
import { useMapStore } from '../../store/useMapStore'
import conflictsData from '../../data/conflicts.json'
import conflictZonesData from '../../data/conflict-zones.json'
import type { Conflict } from '../../types/conflict'
import { fixFeatureCollection, isValidCoord } from '../../utils/geoUtils'
import type { LayerProps } from '../_core/types'

const conflicts = conflictsData as Conflict[]
const safeZones = fixFeatureCollection(conflictZonesData)

const INTENSITY_COLOR: Record<string, string> = {
  critical: '#ef4444',
  high:     '#f97316',
  medium:   '#eab308',
  low:      '#84cc16',
}

export default function ConflictZoneLayer({ visible, labelLayerId, iconsReady }: LayerProps) {
  const { selectConflict, selectedConflict } = useMapStore()

  // GeoJSON of conflict points for the optional symbol overlay. Kept
  // outside the conditional return so the memo stays stable.
  const conflictPointsGeo = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: conflicts
      .filter(c => isValidCoord(c.coordinates))
      .map(c => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: c.coordinates as [number, number] },
        properties: {
          id:        c.id,
          intensity: c.intensity,
        },
      })),
  }), [])

  if (!visible) return null

  return (
    <>
      <Source id="conflict-zones" type="geojson" data={safeZones}>
        <Layer
          id="conflict-zones-fill"
          type="fill"
          beforeId={labelLayerId}
          paint={{
            'fill-color': ['match', ['get', 'intensity'],
              'critical', '#ef4444', 'high', '#f97316',
              'medium', '#eab308', 'low', '#84cc16', '#ef4444',
            ],
            'fill-opacity': 0.15,
          }}
        />
        <Layer
          id="conflict-zones-line"
          type="line"
          beforeId={labelLayerId}
          paint={{
            'line-color': ['match', ['get', 'intensity'],
              'critical', '#ef4444', 'high', '#f97316',
              'medium', '#eab308', 'low', '#84cc16', '#ef4444',
            ],
            'line-width': 1,
            'line-opacity': 0.5,
          }}
        />
      </Source>

      {/* Crossed-swords glyph at low zoom — augments the React Marker pulse
          with a layer-distinguishing icon. The Markers below remain because
          they own the click/select interaction and the pulse animation. */}
      {iconsReady && (
        <Source id="conflict-points" type="geojson" data={conflictPointsGeo}>
          <Layer
            id="conflict-icons"
            type="symbol"
            beforeId={labelLayerId}
            filter={['case',
              ['<', ['zoom'], 1], false,
              ['<', ['zoom'], 3],
                ['in', ['get', 'intensity'], ['literal', ['critical', 'high']]],
              true,
            ]}
            layout={{
              'icon-image': 'layer-conflict',
              'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.4, 6, 0.6, 10, 0.8],
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
              // Offset slightly so the icon doesn't sit dead-center on the
              // pulsing Marker — keeps both visuals readable.
              'icon-offset': [0, -14],
            }}
          />
        </Source>
      )}

      {conflicts.filter(c => isValidCoord(c.coordinates)).map(c => {
        const color = INTENSITY_COLOR[c.intensity] ?? '#ef4444'
        const isSelected = selectedConflict?.id === c.id
        return (
          <Marker
            key={c.id}
            longitude={c.coordinates[0]}
            latitude={c.coordinates[1]}
            anchor="center"
            onClick={e => { e.originalEvent.stopPropagation(); selectConflict(c) }}
          >
            <div className="relative cursor-pointer" style={{ width: 16, height: 16 }}>
              <div className="conflict-pulse absolute rounded-full"
                style={{ inset: 0, border: `1.5px solid ${color}` }} />
              <div className="absolute rounded-full" style={{
                width: 8, height: 8, top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
                background: color,
                border: isSelected ? '2px solid #fff' : '1.5px solid #070B14',
                boxShadow: isSelected ? `0 0 6px ${color}` : 'none',
              }} />
            </div>
          </Marker>
        )
      })}
    </>
  )
}
