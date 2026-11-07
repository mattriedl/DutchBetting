import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash('johndoe123', 12);

  await prisma.user.upsert({
    where: { email: 'john@doe.com' },
    update: {},
    create: {
      email: 'john@doe.com',
      name: 'Admin User',
      password: hashedPassword,
      role: 'admin',
    },
  });

  // Seed sample market data for demonstration
  const sampleMarkets = [
    { kalshiMarketId: 'KXHIGHNY-26JUN05-T62', eventTicker: 'KXHIGHNY-26JUN05', city: 'New York', state: 'NY', tempRangeLow: 60, tempRangeHigh: 62, yesPrice: 12, noPrice: 88, volume: 245, openInterest: 180, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHNY-26JUN05-T64', eventTicker: 'KXHIGHNY-26JUN05', city: 'New York', state: 'NY', tempRangeLow: 62, tempRangeHigh: 64, yesPrice: 22, noPrice: 78, volume: 312, openInterest: 220, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHNY-26JUN05-T66', eventTicker: 'KXHIGHNY-26JUN05', city: 'New York', state: 'NY', tempRangeLow: 64, tempRangeHigh: 66, yesPrice: 35, noPrice: 65, volume: 489, openInterest: 350, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHNY-26JUN05-T68', eventTicker: 'KXHIGHNY-26JUN05', city: 'New York', state: 'NY', tempRangeLow: 66, tempRangeHigh: 68, yesPrice: 28, noPrice: 72, volume: 378, openInterest: 290, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHNY-26JUN05-T70', eventTicker: 'KXHIGHNY-26JUN05', city: 'New York', state: 'NY', tempRangeLow: 68, tempRangeHigh: 70, yesPrice: 15, noPrice: 85, volume: 156, openInterest: 120, expirationTime: new Date('2026-06-05T23:59:00Z') },

    { kalshiMarketId: 'KXHIGHCHI-26JUN05-T72', eventTicker: 'KXHIGHCHI-26JUN05', city: 'Chicago', state: 'IL', tempRangeLow: 70, tempRangeHigh: 72, yesPrice: 18, noPrice: 82, volume: 189, openInterest: 140, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHCHI-26JUN05-T74', eventTicker: 'KXHIGHCHI-26JUN05', city: 'Chicago', state: 'IL', tempRangeLow: 72, tempRangeHigh: 74, yesPrice: 30, noPrice: 70, volume: 267, openInterest: 200, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHCHI-26JUN05-T76', eventTicker: 'KXHIGHCHI-26JUN05', city: 'Chicago', state: 'IL', tempRangeLow: 74, tempRangeHigh: 76, yesPrice: 32, noPrice: 68, volume: 290, openInterest: 210, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHCHI-26JUN05-T78', eventTicker: 'KXHIGHCHI-26JUN05', city: 'Chicago', state: 'IL', tempRangeLow: 76, tempRangeHigh: 78, yesPrice: 20, noPrice: 80, volume: 198, openInterest: 150, expirationTime: new Date('2026-06-05T23:59:00Z') },

    { kalshiMarketId: 'KXHIGHLA-26JUN05-T76', eventTicker: 'KXHIGHLA-26JUN05', city: 'Los Angeles', state: 'CA', tempRangeLow: 74, tempRangeHigh: 76, yesPrice: 15, noPrice: 85, volume: 134, openInterest: 100, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHLA-26JUN05-T78', eventTicker: 'KXHIGHLA-26JUN05', city: 'Los Angeles', state: 'CA', tempRangeLow: 76, tempRangeHigh: 78, yesPrice: 25, noPrice: 75, volume: 210, openInterest: 160, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHLA-26JUN05-T80', eventTicker: 'KXHIGHLA-26JUN05', city: 'Los Angeles', state: 'CA', tempRangeLow: 78, tempRangeHigh: 80, yesPrice: 33, noPrice: 67, volume: 345, openInterest: 260, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHLA-26JUN05-T82', eventTicker: 'KXHIGHLA-26JUN05', city: 'Los Angeles', state: 'CA', tempRangeLow: 80, tempRangeHigh: 82, yesPrice: 22, noPrice: 78, volume: 187, openInterest: 140, expirationTime: new Date('2026-06-05T23:59:00Z') },

    { kalshiMarketId: 'KXHIGHMIA-26JUN05-T86', eventTicker: 'KXHIGHMIA-26JUN05', city: 'Miami', state: 'FL', tempRangeLow: 84, tempRangeHigh: 86, yesPrice: 14, noPrice: 86, volume: 156, openInterest: 120, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHMIA-26JUN05-T88', eventTicker: 'KXHIGHMIA-26JUN05', city: 'Miami', state: 'FL', tempRangeLow: 86, tempRangeHigh: 88, yesPrice: 28, noPrice: 72, volume: 234, openInterest: 180, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHMIA-26JUN05-T90', eventTicker: 'KXHIGHMIA-26JUN05', city: 'Miami', state: 'FL', tempRangeLow: 88, tempRangeHigh: 90, yesPrice: 35, noPrice: 65, volume: 312, openInterest: 240, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHMIA-26JUN05-T92', eventTicker: 'KXHIGHMIA-26JUN05', city: 'Miami', state: 'FL', tempRangeLow: 90, tempRangeHigh: 92, yesPrice: 20, noPrice: 80, volume: 178, openInterest: 130, expirationTime: new Date('2026-06-05T23:59:00Z') },

    { kalshiMarketId: 'KXHIGHDEN-26JUN05-T82', eventTicker: 'KXHIGHDEN-26JUN05', city: 'Denver', state: 'CO', tempRangeLow: 80, tempRangeHigh: 82, yesPrice: 16, noPrice: 84, volume: 123, openInterest: 90, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHDEN-26JUN05-T84', eventTicker: 'KXHIGHDEN-26JUN05', city: 'Denver', state: 'CO', tempRangeLow: 82, tempRangeHigh: 84, yesPrice: 27, noPrice: 73, volume: 201, openInterest: 150, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHDEN-26JUN05-T86', eventTicker: 'KXHIGHDEN-26JUN05', city: 'Denver', state: 'CO', tempRangeLow: 84, tempRangeHigh: 86, yesPrice: 30, noPrice: 70, volume: 267, openInterest: 200, expirationTime: new Date('2026-06-05T23:59:00Z') },
    { kalshiMarketId: 'KXHIGHDEN-26JUN05-T88', eventTicker: 'KXHIGHDEN-26JUN05', city: 'Denver', state: 'CO', tempRangeLow: 86, tempRangeHigh: 88, yesPrice: 22, noPrice: 78, volume: 178, openInterest: 130, expirationTime: new Date('2026-06-05T23:59:00Z') },
  ];

  for (const market of sampleMarkets) {
    await prisma.marketData.upsert({
      where: { id: market.kalshiMarketId },
      update: { ...market },
      create: { id: market.kalshiMarketId, ...market },
    });
  }

  // Seed sample NWS forecasts
  const forecasts = [
    { city: 'New York', state: 'NY', latitude: 40.7128, longitude: -74.006, forecastHigh: 66, forecastDate: new Date('2026-06-05'), confidence: 'high' },
    { city: 'Chicago', state: 'IL', latitude: 41.8781, longitude: -87.6298, forecastHigh: 75, forecastDate: new Date('2026-06-05'), confidence: 'normal' },
    { city: 'Los Angeles', state: 'CA', latitude: 34.0522, longitude: -118.2437, forecastHigh: 79, forecastDate: new Date('2026-06-05'), confidence: 'high' },
    { city: 'Miami', state: 'FL', latitude: 25.7617, longitude: -80.1918, forecastHigh: 89, forecastDate: new Date('2026-06-05'), confidence: 'normal' },
    { city: 'Denver', state: 'CO', latitude: 39.7392, longitude: -104.9903, forecastHigh: 85, forecastDate: new Date('2026-06-05'), confidence: 'normal' },
  ];

  for (const forecast of forecasts) {
    await prisma.nwsForecast.upsert({
      where: { id: `${forecast.city}-${forecast.forecastDate.toISOString().split('T')[0]}` },
      update: { ...forecast },
      create: { ...forecast },
    });
  }

  console.log('Seed completed successfully');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
