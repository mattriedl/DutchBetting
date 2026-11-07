import { ingestExternalPredictions } from '../lib/external-predictions.ts';

async function main() {
  console.log('Starting standalone ingest...');
  try {
    const summary = await ingestExternalPredictions();
    console.log('SUCCESS: Ingest completed.');
    console.log(JSON.stringify(summary, null, 2));
  } catch (error: any) {
    console.error('ERROR: Ingest failed:', error.message);
    process.exit(1);
  }
}

main();
