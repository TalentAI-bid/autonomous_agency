import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { tenants, users, masterAgents, agentConfigs } from './schema/index.js';
import bcrypt from 'bcryptjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://agentcore:agentcore@localhost:5432/agentcore';

async function seed() {
  console.log('Seeding database...');

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool);

  // Create test tenant
  const [tenant] = await db.insert(tenants).values({
    name: 'Acme Corp',
    slug: 'acme',
    plan: 'pro',
    productType: 'recruitment',
    settings: { timezone: 'UTC', maxAgents: 5 },
  }).returning();

  console.log(`Created tenant: ${tenant!.name} (${tenant!.id})`);

  // Create owner user
  const passwordHash = await bcrypt.hash('password123', 12);
  const [user] = await db.insert(users).values({
    tenantId: tenant!.id,
    email: 'admin@acme.com',
    passwordHash,
    name: 'Admin User',
    role: 'owner',
  }).returning();

  console.log(`Created user: ${user!.email} (${user!.id})`);

  // Create a sample master agent
  const [agent] = await db.insert(masterAgents).values({
    tenantId: tenant!.id,
    name: 'Senior Engineer Recruiter',
    description: 'Finds and recruits senior software engineers',
    mission: 'Find senior full-stack engineers with React and Node.js experience, 5+ years, based in Europe. Score based on technical skills and culture fit. Send personalized outreach emails.',
    useCase: 'recruitment',
    config: {
      targetRoles: ['Senior Software Engineer', 'Staff Engineer', 'Tech Lead'],
      skills: ['React', 'Node.js', 'TypeScript', 'PostgreSQL'],
      locations: ['Europe'],
      minExperience: 5,
    },
    createdBy: user!.id,
  }).returning();

  console.log(`Created master agent: ${agent!.name} (${agent!.id})`);

  // Create default agent configs for the master agent
  const agentTypes = ['discovery', 'enrichment', 'document', 'scoring', 'outreach', 'reply', 'action'] as const;
  for (const agentType of agentTypes) {
    await db.insert(agentConfigs).values({
      tenantId: tenant!.id,
      masterAgentId: agent!.id,
      agentType,
      isEnabled: true,
    });
  }

  console.log('Created 7 default agent configs');

  console.log('\n--- Seed Complete ---');
  console.log(`Tenant ID: ${tenant!.id}`);
  console.log(`User Email: admin@acme.com`);
  console.log(`User Password: password123`);
  console.log(`Master Agent ID: ${agent!.id}`);

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
