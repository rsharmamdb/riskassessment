export const BRAND_NAME = "Case Risk Analysis";
export const BRAND_TAGLINE = "Turn case evidence into clearer risk decisions";

export const BRAND_LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none" role="img" aria-label="Case Risk Analysis logo">
  <circle cx="64" cy="64" r="64" fill="#0B2536"/>
  <path d="M64 16C60 23 54 31 48 39C38 52 32 67 32 81C32 103 45 120 62 124L63.6 114C58.8 111.8 56 107.3 56 102.1L62 48L68 102.1C68 107.3 65.2 111.8 60.4 114L62 124C79 120 92 103 92 81C92 67 86 52 76 39C70 31 64 23 64 16Z" fill="#09E85E"/>
  <path d="M62 124H66.6L68.8 101.5L64 96L59.2 101.5L62 124Z" fill="#09E85E"/>
</svg>`;

export function brandLogoDataUri(): string {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(BRAND_LOGO_SVG)}`;
}
