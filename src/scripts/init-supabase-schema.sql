create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  name text,
  avatar_url text,
  phone text,
  website text,
  role text not null default 'member' check (role in ('member', 'admin', 'owner', 'super_admin')),
  preferences jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  email_verified boolean not null default false,
  last_login timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'free' check (plan in ('free', 'pro', 'enterprise')),
  status text not null default 'active' check (status in ('active', 'inactive', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'admin', 'owner', 'super_admin')),
  status text not null default 'active' check (status in ('active', 'inactive', 'pending', 'suspended')),
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, tenant_id)
);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  owner_id uuid references public.users(id) on delete set null,
  tenant_id uuid references public.tenants(id) on delete cascade,
  config jsonb not null default '{}'::jsonb,
  api_key text unique,
  system_prompt text,
  is_public boolean not null default false,
  allowed_origins text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  metadata jsonb not null default '{}'::jsonb,
  agent_id uuid references public.agents(id) on delete set null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  file_url text,
  file_type text,
  file_size bigint,
  file_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.analytics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete set null,
  query text not null,
  response text,
  vector_score double precision,
  created_at timestamptz not null default now()
);

create table if not exists public.user_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_type text not null check (token_type in ('access', 'refresh', 'password_reset', 'email_verification')),
  token_value text not null unique,
  expires_at timestamptz not null,
  is_revoked boolean not null default false,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.webhooks (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents(id) on delete cascade,
  tenant_id uuid references public.tenants(id) on delete cascade,
  event_type text not null,
  url text not null,
  headers jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_agents_owner_id on public.agents(owner_id);
create index if not exists idx_agents_tenant_id on public.agents(tenant_id);
create index if not exists idx_agents_api_key on public.agents(api_key);
create index if not exists idx_knowledge_tenant_id on public.knowledge(tenant_id);
create index if not exists idx_knowledge_user_id on public.knowledge(user_id);
create index if not exists idx_knowledge_agent_id on public.knowledge(agent_id);
create index if not exists idx_analytics_tenant_id on public.analytics(tenant_id);
create index if not exists idx_analytics_user_id on public.analytics(user_id);
create index if not exists idx_analytics_agent_id on public.analytics(agent_id);
create index if not exists idx_user_tokens_user_id on public.user_tokens(user_id);
create index if not exists idx_user_tokens_token_value on public.user_tokens(token_value);
create index if not exists idx_memberships_user_id on public.user_tenant_memberships(user_id);
create index if not exists idx_memberships_tenant_id on public.user_tenant_memberships(tenant_id);
create index if not exists idx_webhooks_agent_id on public.webhooks(agent_id);
create index if not exists idx_webhooks_tenant_id on public.webhooks(tenant_id);

drop trigger if exists set_users_updated_at on public.users;
create trigger set_users_updated_at
before update on public.users
for each row execute function public.set_updated_at();

drop trigger if exists set_tenants_updated_at on public.tenants;
create trigger set_tenants_updated_at
before update on public.tenants
for each row execute function public.set_updated_at();

drop trigger if exists set_memberships_updated_at on public.user_tenant_memberships;
create trigger set_memberships_updated_at
before update on public.user_tenant_memberships
for each row execute function public.set_updated_at();

drop trigger if exists set_agents_updated_at on public.agents;
create trigger set_agents_updated_at
before update on public.agents
for each row execute function public.set_updated_at();

drop trigger if exists set_knowledge_updated_at on public.knowledge;
create trigger set_knowledge_updated_at
before update on public.knowledge
for each row execute function public.set_updated_at();

drop trigger if exists set_user_tokens_updated_at on public.user_tokens;
create trigger set_user_tokens_updated_at
before update on public.user_tokens
for each row execute function public.set_updated_at();

drop trigger if exists set_webhooks_updated_at on public.webhooks;
create trigger set_webhooks_updated_at
before update on public.webhooks
for each row execute function public.set_updated_at();

create or replace function public.get_user_tenants(user_id uuid)
returns table (
  id uuid,
  tenant jsonb,
  role text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    utm.id,
    jsonb_build_object(
      'id', t.id,
      'name', t.name,
      'plan', t.plan,
      'status', t.status,
      'created_at', t.created_at,
      'updated_at', t.updated_at
    ) as tenant,
    utm.role,
    utm.created_at
  from public.user_tenant_memberships utm
  join public.tenants t on t.id = utm.tenant_id
  where utm.user_id = get_user_tenants.user_id
  order by utm.created_at desc;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on function public.get_user_tenants(uuid) to service_role;

alter table public.users enable row level security;
alter table public.tenants enable row level security;
alter table public.user_tenant_memberships enable row level security;
alter table public.agents enable row level security;
alter table public.knowledge enable row level security;
alter table public.analytics enable row level security;
alter table public.user_tokens enable row level security;
alter table public.webhooks enable row level security;