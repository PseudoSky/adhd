import { Collections, Filters } from "@adhd/transform";

type PropMapping = {
    longitude: string; 
    latitude: string;
}
export type Coordinate = {
    latitude: number;
    longitude: number;
}

type CoordinateWithDelta = Coordinate & {longitudeDelta: number, latitudeDelta: number}

const DefaultProps: PropMapping = { longitude: "longitude", latitude: "latitude" };
const DefaultPadding: Coordinate = { latitude: 0.047, longitude: 0.044 };

export function distance(lat1: number, lon1: number, lat2: number, lon2: number, unit: "K" | "N"| "G"="G") {
  if (lat1 == lat2 && lon1 == lon2) {
    return 0;
  } else {
    const radlat1 = (Math.PI * lat1) / 180;
    const radlat2 = (Math.PI * lat2) / 180;
    const theta = lon1 - lon2;
    const radtheta = (Math.PI * theta) / 180;
    let dist =
      Math.sin(radlat1) * Math.sin(radlat2) +
      Math.cos(radlat1) * Math.cos(radlat2) * Math.cos(radtheta);
    if (dist > 1) {
      dist = 1;
    }
    dist = Math.acos(dist);
    dist = (dist * 180) / Math.PI;
    dist = dist * 60 * 1.1515;
    if (unit == "K") {
      dist = dist * 1.609344;
    }
    if (unit == "N") {
      dist = dist * 0.8684;
    }
    return dist;
  }
}

export function within<T extends Coordinate>(collection: T[] , center: Coordinate, dist: number) {
  return collection.filter(({ latitude, longitude }) => {
    return (
      distance(latitude, longitude, center.latitude, center.longitude) < dist
    );
  });
}

export function LatLon(latitude: number, longitude: number) {
  return { latitude, longitude };
}

export function Cardinal(collection: any[], props = DefaultProps) {
  const [latMin, lonMin, latMax, lonMax] = Bbox(collection, props);
  return {
    southWest: [latMin, lonMin],
    northEast: [latMax, lonMax]
  };
}

export function Bbox<T=any>(collection: T[], props: PropMapping = DefaultProps) {
  const [lon, lat] = Collections.rangeByProps(collection, [props.longitude, props.latitude]);
  return [lat.min, lon.min, lat.max, lon.max];
}

export function Region<Data=any>(
  collection: Data[],
  props = DefaultProps,
  padding = DefaultPadding
) {
  if (Filters.isEmpty(collection)) return null;
  const box = Bbox(collection, props);
  const ld = (box[2] - box[0]) * 1.5;
  return {
    latitude: (box[0] + box[2]) / 2 - ld/3, // north south
    longitude: (box[1] + box[3]) / 2, // east west
    latitudeDelta: ld,
    longitudeDelta: (box[3] - box[1]) * 1.5
  };
}

Region.isValid = ({ longitude, latitude, longitudeDelta, latitudeDelta }: CoordinateWithDelta) => {
  return [longitude, latitude, longitudeDelta, latitudeDelta].every(
    Filters.isFloat
  );
};

export default {
  distance,
  within,
  LatLon,
  Cardinal,
  Bbox,
  Region
};