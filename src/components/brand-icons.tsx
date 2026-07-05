import type { ComponentType, ReactNode, SVGProps } from "react";
import { Plug } from "@/components/icons";

/**
 * Centralized, monochrome brand marks for every Data-tab source. One source of
 * truth: every mark is `fill="currentColor"`, viewBox `0 0 24 24`, single-color
 * so it reads in light and dark and inherits the row's text colour. Consumers
 * (GithubConnect, SourceConnect, SourceRow) resolve an icon via `brandIcon(id)`
 * — never a first-letter box, never a generic sparkle, never a per-component
 * copy. Unknown manual drops fall back to the neutral Plug.
 */
type P = SVGProps<SVGSVGElement>;
export type IconComponent = ComponentType<P>;

/** Shared svg shell: fill-based, currentColor, 24-grid. Caller sets size/class. */
function Mark({ children, ...p }: P & { children: ReactNode }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" {...p}>
      {children}
    </svg>
  );
}

/* ---- Faithful single-path brand marks (simple-icons geometry) ------------ */

const GitHub = (p: P) => (
  <Mark {...p}>
    <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.13-.3-.54-1.53.12-3.19 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.89.12 3.19.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" />
  </Mark>
);

const Spotify = (p: P) => (
  <Mark {...p}>
    <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.42 1.56-.299.421-1.02.599-1.559.3z" />
  </Mark>
);

const Apple = (p: P) => (
  <Mark {...p}>
    <path d="M17.05 12.54c-.03-2.6 2.12-3.85 2.22-3.91-1.21-1.77-3.1-2.01-3.77-2.04-1.6-.16-3.13.94-3.94.94-.82 0-2.07-.92-3.4-.9-1.75.03-3.37 1.02-4.27 2.59-1.82 3.16-.47 7.83 1.31 10.4.87 1.26 1.9 2.67 3.26 2.62 1.31-.05 1.8-.85 3.39-.85 1.57 0 2.03.85 3.4.82 1.4-.02 2.29-1.28 3.15-2.55.99-1.46 1.4-2.87 1.42-2.94-.03-.02-2.72-1.05-2.75-4.14zM14.5 4.59c.72-.88 1.21-2.09 1.08-3.3-1.04.04-2.3.69-3.05 1.56-.67.77-1.26 2.01-1.1 3.19 1.16.09 2.35-.59 3.07-1.45z" />
  </Mark>
);

const Slack = (p: P) => (
  <Mark {...p}>
    <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
  </Mark>
);

const Telegram = (p: P) => (
  <Mark {...p}>
    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
  </Mark>
);

const Chrome = (p: P) => (
  <Mark {...p}>
    <path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728z" />
  </Mark>
);

const WhatsApp = (p: P) => (
  <Mark {...p}>
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z" />
  </Mark>
);

/* ---- Hand-built monochrome marks (mixed fill + stroke) -------------------- */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Google Calendar — folded page frame + the signature "31". */
const GoogleCalendar = (p: P) => (
  <Mark {...p}>
    <rect x="3.5" y="4.5" width="17" height="16" rx="2.5" strokeWidth="1.7" {...stroke} />
    <path d="M8 3v3M16 3v3" strokeWidth="1.7" {...stroke} />
    <text
      x="12"
      y="17"
      textAnchor="middle"
      fontSize="9"
      fontWeight="700"
      fontFamily="system-ui, sans-serif"
      fill="currentColor"
      stroke="none"
    >
      31
    </text>
  </Mark>
);

/** WHOOP — the brand's bold angular W. */
const Whoop = (p: P) => (
  <Mark {...p}>
    <path d="M2 6 6.6 18 12 8.4 17.4 18 22 6" strokeWidth="2.6" fill="none" stroke="currentColor" strokeLinejoin="miter" strokeLinecap="butt" />
  </Mark>
);

/** RescueTime — a stopwatch (time tracking). */
const RescueTime = (p: P) => (
  <Mark {...p}>
    <circle cx="12" cy="13.5" r="7.5" strokeWidth="1.7" {...stroke} />
    <path d="M12 13.5 15.2 10.3M12 4.6V6M9.5 3h5" strokeWidth="1.7" {...stroke} />
    <path d="M18.5 6.2 20 4.7" strokeWidth="1.7" {...stroke} />
  </Mark>
);

/** Notion — the N in a rounded page. */
const Notion = (p: P) => (
  <Mark {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" strokeWidth="1.7" {...stroke} />
    <path d="M8.5 16.5V8l7 8.5V8" strokeWidth="1.7" {...stroke} />
  </Mark>
);

/** Firefox — a flame. */
const Firefox = (p: P) => (
  <Mark {...p}>
    <path d="M12 2c.8 2.4 2.6 3.4 3.4 5.2.5 1.1.4 2.3-.2 3.2 1-.4 1.8-1.3 2.2-2.4.7 1.3 1.1 2.8 1.1 4.3a6.5 6.5 0 1 1-12.4-2.7c.6 1 1.6 1.7 2.7 1.9-1.3-2.8.3-6.2 3.2-9.5z" />
  </Mark>
);

/** Safari — a compass. */
const Safari = (p: P) => (
  <Mark {...p}>
    <circle cx="12" cy="12" r="9.5" strokeWidth="1.7" {...stroke} />
    <path d="M16.8 7.2 13 11l-1.8 5.8L7.2 16.8 11 13z" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
  </Mark>
);

/** iMessage / Messages — a rounded speech bubble. */
const IMessage = (p: P) => (
  <Mark {...p}>
    <path d="M12 3C6.5 3 2 6.6 2 11c0 2.5 1.4 4.7 3.6 6.1-.2 1-.8 2.3-1.6 3.4 1.6-.3 3.2-.9 4.4-1.7 1.1.3 2.3.5 3.6.5 5.5 0 10-3.6 10-8s-4.5-8-10-8z" />
  </Mark>
);

/** OwnTracks / Location — a map pin with a hole. */
const LocationPin = (p: P) => (
  <Mark {...p}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 4.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z"
    />
  </Mark>
);

/** Google Timeline — a solid Maps marker. */
const MapsPin = (p: P) => (
  <Mark {...p}>
    <path d="M12 2C8.1 2 5 5.1 5 9c0 4.9 7 13 7 13s7-8.1 7-13c0-3.9-3.1-7-7-7z" />
    <circle cx="12" cy="9" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </Mark>
);

/**
 * Source-id → brand mark. Keys cover the live sources plus the aliases a manual
 * drop can land under (a pasted `whatsapp.csv` → `whatsapp`, etc.). Add a source =
 * add a key here, not a new component elsewhere.
 */
export const BRAND_ICONS: Record<string, IconComponent> = {
  // live sources
  github: GitHub,
  rescuetime: RescueTime,
  gcal: GoogleCalendar,
  spotify: Spotify,
  whoop: Whoop,
  chrome: Chrome,
  iphone: Apple,
  "apple-health": Apple,
  // manual-drop aliases
  apple: Apple,
  "google-calendar": GoogleCalendar,
  calendar: GoogleCalendar,
  notion: Notion,
  slack: Slack,
  telegram: Telegram,
  firefox: Firefox,
  safari: Safari,
  whatsapp: WhatsApp,
  imessage: IMessage,
  messages: IMessage,
  owntracks: LocationPin,
  location: LocationPin,
  timeline: MapsPin,
  "google-timeline": MapsPin,
  maps: MapsPin,
};

/** Resolve a source id to its brand mark, falling back to the neutral Plug. */
export function brandIcon(id: string): IconComponent {
  return BRAND_ICONS[id.toLowerCase()] ?? Plug;
}
