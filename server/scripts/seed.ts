import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MOCK_UPSTREAM_BASE_URL =
  process.env.MOCK_UPSTREAM_BASE_URL ?? 'http://localhost:4000';

interface SeedApi {
  name: string;
  slug: string;
  description: string;
  upstreamPath: string;
  pricePerCallCents: number;
}

const DEMO_PROVIDER = {
  name: 'Demo Provider',
  slug: 'demo-provider',
  description: 'A demo provider used for local development and UI work.',
  contactEmail: 'demo@example.com',
};

const DEMO_APIS: SeedApi[] = [
  {
    name: 'Echo',
    slug: 'echo',
    description: 'Echoes back the request payload. Useful for smoke tests.',
    upstreamPath: '/echo',
    pricePerCallCents: 1,
  },
  {
    name: 'Weather',
    slug: 'weather',
    description: 'Returns mock weather data for a given city.',
    upstreamPath: '/weather',
    pricePerCallCents: 2,
  },
  {
    name: 'Currency Rates',
    slug: 'currency-rates',
    description: 'Returns mock foreign exchange rates.',
    upstreamPath: '/rates',
    pricePerCallCents: 3,
  },
  {
    name: 'Text Summarizer',
    slug: 'text-summarizer',
    description: 'Returns a mock summary for the provided text.',
    upstreamPath: '/summarize',
    pricePerCallCents: 5,
  },
];

async function main(): Promise<void> {
  const provider = await prisma.provider.upsert({
    where: { slug: DEMO_PROVIDER.slug },
    update: {
      name: DEMO_PROVIDER.name,
      description: DEMO_PROVIDER.description,
      contactEmail: DEMO_PROVIDER.contactEmail,
    },
    create: {
      name: DEMO_PROVIDER.name,
      slug: DEMO_PROVIDER.slug,
      description: DEMO_PROVIDER.description,
      contactEmail: DEMO_PROVIDER.contactEmail,
    },
  });

  for (const api of DEMO_APIS) {
    const upstreamUrl = `${MOCK_UPSTREAM_BASE_URL}${api.upstreamPath}`;

    await prisma.api.upsert({
      where: { slug: api.slug },
      update: {
        name: api.name,
        description: api.description,
        upstreamUrl,
        pricePerCallCents: api.pricePerCallCents,
        listed: true,
        providerId: provider.id,
      },
      create: {
        name: api.name,
        slug: api.slug,
        description: api.description,
        upstreamUrl,
        pricePerCallCents: api.pricePerCallCents,
        listed: true,
        providerId: provider.id,
      },
    });
  }

  console.log(
    `Seeded provider "${provider.name}" with ${DEMO_APIS.length} listed APIs.`,
  );
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });