// Sample home links return to the gallery instead of leaving its publication.
export const hrefFor = (_route: string) => "#threads";
export const navigate = (_route: string) => {
  location.hash = "threads";
};
