// Sample home links return to the gallery instead of leaving its publication.
export const hrefFor = (_route: string) => "#threads";
export const routeFor = (_pathname: string): string | null => null;
export const navigate = (_route: string) => {
  location.hash = "threads";
};
