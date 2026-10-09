// Sample home links return to the gallery instead of leaving its publication.
export const hrefFor = (_route: string) => "#discussions";
export const navigate = (_route: string) => {
  location.hash = "discussions";
};
