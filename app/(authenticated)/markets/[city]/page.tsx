import { CityDetailContent } from './_components/city-detail-content';

export default function CityDetailPage({ params }: { params: { city: string } }) {
  return <CityDetailContent cityParam={params?.city ?? ''} />;
}
