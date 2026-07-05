declare module 'react-simple-maps' {
  import type { ReactNode, SVGProps, MouseEvent, CSSProperties } from 'react'

  export interface Geography {
    rsmKey: string
    id: string
    properties: Record<string, string>
    [key: string]: unknown
  }

  export interface ComposableMapProps {
    projection?: string
    projectionConfig?: Record<string, unknown>
    style?: CSSProperties
    children?: ReactNode
  }

  export interface ZoomableGroupProps {
    zoom?: number
    center?: [number, number]
    onMoveEnd?: (position: { coordinates: [number, number]; zoom: number }) => void
    children?: ReactNode
  }

  export interface GeographiesProps {
    geography: string | object
    children: (props: { geographies: Geography[] }) => ReactNode
  }

  export interface GeographyProps extends SVGProps<SVGPathElement> {
    geography: Geography
    style?: {
      default?: CSSProperties
      hover?: CSSProperties
      pressed?: CSSProperties
    }
    onMouseEnter?: (event: MouseEvent<SVGPathElement>) => void
    onMouseMove?: (event: MouseEvent<SVGPathElement>) => void
    onMouseLeave?: (event: MouseEvent<SVGPathElement>) => void
    onClick?: (event: MouseEvent<SVGPathElement>) => void
  }

  export interface MarkerProps extends SVGProps<SVGGElement> {
    coordinates: [number, number]
    children?: ReactNode
  }

  export interface SphereProps extends SVGProps<SVGPathElement> {
    id?: string
    fill?: string
    stroke?: string
    strokeWidth?: number
  }

  export interface GraticuleProps extends SVGProps<SVGPathElement> {
    stroke?: string
    strokeWidth?: number
    fill?: string
    step?: [number, number]
  }

  export interface LineProps {
    from: [number, number]
    to: [number, number]
    coordinates?: [number, number][]
    stroke?: string
    strokeWidth?: number
    strokeOpacity?: number
    strokeLinecap?: 'round' | 'butt' | 'square'
    fill?: string
    curve?: number
    style?: CSSProperties
  }

  export function ComposableMap(props: ComposableMapProps): JSX.Element
  export function ZoomableGroup(props: ZoomableGroupProps): JSX.Element
  export function Geographies(props: GeographiesProps): JSX.Element
  export function Geography(props: GeographyProps): JSX.Element
  export function Marker(props: MarkerProps): JSX.Element
  export function Line(props: LineProps): JSX.Element
  export function Sphere(props: SphereProps): JSX.Element
  export function Graticule(props: GraticuleProps): JSX.Element
}
