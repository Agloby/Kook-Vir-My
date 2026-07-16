


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";




COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."consume_ai_quota"("p_kind" "text") RETURNS TABLE("allowed" boolean, "used" integer, "daily_limit" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user uuid := auth.uid();
  v_limit integer;
  v_used integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_kind = 'recipe' then v_limit := 20;
  elsif p_kind = 'photo' then v_limit := 10;
  else raise exception 'Invalid quota kind';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || current_date::text || p_kind, 0));
  select request_count into v_used from public.ai_daily_usage
    where user_id = v_user and usage_date = current_date and request_kind = p_kind;
  v_used := coalesce(v_used, 0);
  if v_used >= v_limit then return query select false, v_used, v_limit; return; end if;

  insert into public.ai_daily_usage (user_id, usage_date, request_kind, request_count)
    values (v_user, current_date, p_kind, 1)
    on conflict (user_id, usage_date, request_kind)
    do update set request_count = public.ai_daily_usage.request_count + 1
    returning request_count into v_used;
  return query select true, v_used, v_limit;
end;
$$;




CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare new_household_id uuid;
begin
  insert into public.profiles (id, display_name) values (new.id, new.email);
  insert into public.households (name) values ('Our household') returning id into new_household_id;
  insert into public.household_members (household_id, user_id, role) values (new_household_id, new.id, 'owner');
  return new;
end;
$$;




CREATE OR REPLACE FUNCTION "public"."join_household"("p_code" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  target_id uuid;
  recent_attempts int;
begin
  delete from public.household_join_attempts where attempted_at < now() - interval '1 hour';

  select count(*) into recent_attempts
    from public.household_join_attempts
    where user_id = auth.uid() and attempted_at > now() - interval '1 hour';
  if recent_attempts >= 10 then
    raise exception 'Too many join attempts - please wait a while before trying another code.';
  end if;

  insert into public.household_join_attempts (user_id) values (auth.uid());

  select id into target_id from public.households where invite_code = p_code;
  if target_id is null then
    raise exception 'Invalid invite code';
  end if;
  insert into public.household_members (household_id, user_id, role)
    values (target_id, auth.uid(), 'member')
    on conflict (user_id) do update set household_id = excluded.household_id, role = 'member';
  return target_id;
end;
$$;



SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."pantry_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "household_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "quantity" numeric DEFAULT 0 NOT NULL,
    "unit" "text",
    "par_level" numeric,
    "track_consumption" boolean DEFAULT false NOT NULL,
    "expiry_date" "date",
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "barcode" "text",
    "brand" "text",
    "product_data" "jsonb",
    "nutrition_per_100g" "jsonb",
    "ingredients_text" "text",
    "allergen_text" "text",
    "reminder_snooze_until" "date",
    CONSTRAINT "pantry_items_source_check" CHECK (("source" = ANY (ARRAY['manual'::"text", 'photo'::"text", 'barcode'::"text"])))
);




CREATE OR REPLACE FUNCTION "public"."set_pantry_quantities"("p_changes" "jsonb") RETURNS SETOF "public"."pantry_items"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_change jsonb; v_id uuid; v_quantity numeric;
begin
  if auth.uid() is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 100 then
    raise exception 'Invalid pantry update';
  end if;
  for v_change in select value from jsonb_array_elements(p_changes) loop
    v_id := (v_change->>'id')::uuid; v_quantity := (v_change->>'quantity')::numeric;
    if v_quantity < 0 then raise exception 'Quantity cannot be negative'; end if;
    if not exists (
      select 1 from public.pantry_items p join public.household_members hm on hm.household_id=p.household_id
      where p.id=v_id and hm.user_id=auth.uid()
    ) then raise exception 'Pantry item is unavailable'; end if;
  end loop;
  return query
    update public.pantry_items p set quantity=(c.value->>'quantity')::numeric, updated_at=now()
    from jsonb_array_elements(p_changes) c(value)
    where p.id=(c.value->>'id')::uuid returning p.*;
end;
$$;




CREATE TABLE IF NOT EXISTS "public"."ai_daily_usage" (
    "user_id" "uuid" NOT NULL,
    "usage_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "request_kind" "text" NOT NULL,
    "request_count" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "ai_daily_usage_request_count_check" CHECK (("request_count" >= 0)),
    CONSTRAINT "ai_daily_usage_request_kind_check" CHECK (("request_kind" = ANY (ARRAY['recipe'::"text", 'photo'::"text"])))
);




CREATE TABLE IF NOT EXISTS "public"."household_join_attempts" (
    "user_id" "uuid" NOT NULL,
    "attempted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);




CREATE TABLE IF NOT EXISTS "public"."household_members" (
    "household_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'owner'::"text" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "household_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'member'::"text"])))
);




CREATE TABLE IF NOT EXISTS "public"."households" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" DEFAULT 'Our household'::"text" NOT NULL,
    "invite_code" "text" DEFAULT "substr"("md5"((("random"())::"text" || ("clock_timestamp"())::"text")), 1, 8) NOT NULL,
    "delivery_address" "text",
    "delivery_eircode" "text",
    "delivery_lat" double precision,
    "delivery_lon" double precision,
    "allergies" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "diets" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);




CREATE TABLE IF NOT EXISTS "public"."ingredient_prices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ingredient_name" "text" NOT NULL,
    "unit" "text",
    "price" numeric NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "household_id" "uuid" NOT NULL
);




CREATE TABLE IF NOT EXISTS "public"."leftovers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "household_id" "uuid" NOT NULL,
    "recipe_id" "uuid",
    "recipe_title" "text",
    "amount" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "consumed_at" timestamp with time zone
);




CREATE TABLE IF NOT EXISTS "public"."meal_plan_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "meal_plan_id" "uuid" NOT NULL,
    "household_id" "uuid" NOT NULL,
    "meal_date" "date" NOT NULL,
    "meal_slot" "text" NOT NULL,
    "recipe_id" "uuid",
    "manual_title" "text",
    "servings" integer,
    "use_leftovers" boolean DEFAULT false NOT NULL,
    "leftover_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "meal_plan_items_meal_slot_check" CHECK (("meal_slot" = ANY (ARRAY['breakfast'::"text", 'lunch'::"text", 'dinner'::"text", 'snack'::"text"])))
);




CREATE TABLE IF NOT EXISTS "public"."meal_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "household_id" "uuid" NOT NULL,
    "week_start" "date" NOT NULL,
    "title" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);




CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "display_name" "text",
    "units_preference" "text" DEFAULT 'metric'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "goals" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "profiles_units_preference_check" CHECK (("units_preference" = ANY (ARRAY['metric'::"text", 'us'::"text"])))
);




CREATE TABLE IF NOT EXISTS "public"."recipe_feedback_tags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipe_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "tag" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);




CREATE TABLE IF NOT EXISTS "public"."recipe_ratings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipe_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "taste" smallint,
    "convenience" smallint,
    "cost" smallint,
    "serving_size" smallint,
    "comment" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "recipe_ratings_convenience_check" CHECK ((("convenience" >= 1) AND ("convenience" <= 5))),
    CONSTRAINT "recipe_ratings_cost_check" CHECK ((("cost" >= 1) AND ("cost" <= 5))),
    CONSTRAINT "recipe_ratings_serving_size_check" CHECK ((("serving_size" >= 1) AND ("serving_size" <= 5))),
    CONSTRAINT "recipe_ratings_taste_check" CHECK ((("taste" >= 1) AND ("taste" <= 5)))
);




CREATE TABLE IF NOT EXISTS "public"."recipes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "cuisine" "text",
    "total_time_minutes" integer,
    "servings" integer,
    "ingredients" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "steps" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "allergen_note" "text",
    "cost_estimate" numeric,
    "cost_estimate_basis" "text",
    "is_favourite" boolean DEFAULT false NOT NULL,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "household_id" "uuid" NOT NULL,
    "calories_per_serving" numeric,
    "protein_g_per_serving" numeric,
    "shopping_note" "text"
);




CREATE TABLE IF NOT EXISTS "public"."shopping_list_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "shopping_list_id" "uuid" NOT NULL,
    "household_id" "uuid" NOT NULL,
    "item_name" "text" NOT NULL,
    "quantity" numeric,
    "unit" "text",
    "quantity_text" "text",
    "category" "text",
    "notes" "text",
    "status" "text" DEFAULT 'required'::"text" NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "recipe_id" "uuid",
    "pantry_item_id" "uuid",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "shopping_list_items_status_check" CHECK (("status" = ANY (ARRAY['required'::"text", 'optional'::"text", 'check_pantry'::"text", 'already_have'::"text", 'bought'::"text"])))
);




CREATE TABLE IF NOT EXISTS "public"."shopping_lists" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "household_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "fulfilment_method" "text" DEFAULT 'in_store'::"text" NOT NULL,
    "retailer_name" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pepesto_last_compared_at" timestamp with time zone,
    CONSTRAINT "shopping_lists_fulfilment_method_check" CHECK (("fulfilment_method" = ANY (ARRAY['delivery'::"text", 'click_collect'::"text", 'in_store'::"text", 'whatsapp'::"text"]))),
    CONSTRAINT "shopping_lists_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'completed'::"text", 'archived'::"text"])))
);




CREATE TABLE IF NOT EXISTS "public"."shops" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "pinned" boolean DEFAULT false NOT NULL,
    "delivery_confirmed" boolean DEFAULT false NOT NULL,
    "website_url" "text",
    "distance_km" numeric,
    "selected" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "household_id" "uuid" NOT NULL,
    CONSTRAINT "shops_source_check" CHECK (("source" = ANY (ARRAY['detected'::"text", 'manual'::"text", 'pinned'::"text"])))
);




ALTER TABLE ONLY "public"."ai_daily_usage"
    ADD CONSTRAINT "ai_daily_usage_pkey" PRIMARY KEY ("user_id", "usage_date", "request_kind");



ALTER TABLE ONLY "public"."household_members"
    ADD CONSTRAINT "household_members_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."households"
    ADD CONSTRAINT "households_invite_code_key" UNIQUE ("invite_code");



ALTER TABLE ONLY "public"."households"
    ADD CONSTRAINT "households_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ingredient_prices"
    ADD CONSTRAINT "ingredient_prices_household_ingredient_unit_key" UNIQUE ("household_id", "ingredient_name", "unit");



ALTER TABLE ONLY "public"."ingredient_prices"
    ADD CONSTRAINT "ingredient_prices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leftovers"
    ADD CONSTRAINT "leftovers_id_household_unique" UNIQUE ("id", "household_id");



ALTER TABLE ONLY "public"."leftovers"
    ADD CONSTRAINT "leftovers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meal_plan_items"
    ADD CONSTRAINT "meal_plan_items_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."meal_plan_items"
    ADD CONSTRAINT "meal_plan_items_servings_range" CHECK ((("servings" IS NULL) OR (("servings" >= 1) AND ("servings" <= 100)))) NOT VALID;



ALTER TABLE "public"."meal_plan_items"
    ADD CONSTRAINT "meal_plan_items_text_lengths" CHECK (((("manual_title" IS NULL) OR (("char_length"("manual_title") >= 1) AND ("char_length"("manual_title") <= 200))) AND (("notes" IS NULL) OR ("char_length"("notes") <= 1000)))) NOT VALID;



ALTER TABLE ONLY "public"."meal_plans"
    ADD CONSTRAINT "meal_plans_household_id_week_start_key" UNIQUE ("household_id", "week_start");



ALTER TABLE ONLY "public"."meal_plans"
    ADD CONSTRAINT "meal_plans_id_household_unique" UNIQUE ("id", "household_id");



ALTER TABLE ONLY "public"."meal_plans"
    ADD CONSTRAINT "meal_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pantry_items"
    ADD CONSTRAINT "pantry_items_id_household_unique" UNIQUE ("id", "household_id");



ALTER TABLE "public"."pantry_items"
    ADD CONSTRAINT "pantry_items_par_nonnegative" CHECK ((("par_level" IS NULL) OR ("par_level" >= (0)::numeric))) NOT VALID;



ALTER TABLE ONLY "public"."pantry_items"
    ADD CONSTRAINT "pantry_items_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."pantry_items"
    ADD CONSTRAINT "pantry_items_quantity_nonnegative" CHECK (("quantity" >= (0)::numeric)) NOT VALID;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."recipe_feedback_tags"
    ADD CONSTRAINT "recipe_feedback_tags_allowed" CHECK (("tag" = ANY (ARRAY['make again'::"text", 'great taste'::"text", 'wife liked it'::"text", 'child liked it'::"text", 'good for leftovers'::"text", 'too much effort'::"text", 'too many dishes'::"text", 'too expensive'::"text", 'high protein win'::"text", 'too bland'::"text", 'avoid next time'::"text"]))) NOT VALID;



ALTER TABLE ONLY "public"."recipe_feedback_tags"
    ADD CONSTRAINT "recipe_feedback_tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."recipe_feedback_tags"
    ADD CONSTRAINT "recipe_feedback_tags_recipe_id_profile_id_tag_key" UNIQUE ("recipe_id", "profile_id", "tag");



ALTER TABLE ONLY "public"."recipe_ratings"
    ADD CONSTRAINT "recipe_ratings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."recipe_ratings"
    ADD CONSTRAINT "recipe_ratings_recipe_id_profile_id_key" UNIQUE ("recipe_id", "profile_id");



ALTER TABLE ONLY "public"."recipes"
    ADD CONSTRAINT "recipes_id_household_unique" UNIQUE ("id", "household_id");



ALTER TABLE ONLY "public"."recipes"
    ADD CONSTRAINT "recipes_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."shopping_list_items"
    ADD CONSTRAINT "shopping_list_items_name_length" CHECK ((("char_length"("btrim"("item_name")) >= 1) AND ("char_length"("btrim"("item_name")) <= 200))) NOT VALID;



ALTER TABLE ONLY "public"."shopping_list_items"
    ADD CONSTRAINT "shopping_list_items_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."shopping_list_items"
    ADD CONSTRAINT "shopping_list_items_quantity_nonnegative" CHECK ((("quantity" IS NULL) OR ("quantity" >= (0)::numeric))) NOT VALID;



ALTER TABLE "public"."shopping_list_items"
    ADD CONSTRAINT "shopping_list_items_text_lengths" CHECK (((("unit" IS NULL) OR ("char_length"("unit") <= 40)) AND (("quantity_text" IS NULL) OR ("char_length"("quantity_text") <= 100)) AND (("category" IS NULL) OR ("char_length"("category") <= 80)) AND (("notes" IS NULL) OR ("char_length"("notes") <= 500)))) NOT VALID;



ALTER TABLE ONLY "public"."shopping_lists"
    ADD CONSTRAINT "shopping_lists_id_household_unique" UNIQUE ("id", "household_id");



ALTER TABLE ONLY "public"."shopping_lists"
    ADD CONSTRAINT "shopping_lists_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."shopping_lists"
    ADD CONSTRAINT "shopping_lists_title_length" CHECK ((("char_length"("btrim"("title")) >= 1) AND ("char_length"("btrim"("title")) <= 120))) NOT VALID;



ALTER TABLE ONLY "public"."shops"
    ADD CONSTRAINT "shops_pkey" PRIMARY KEY ("id");



CREATE INDEX "household_join_attempts_user_time_idx" ON "public"."household_join_attempts" USING "btree" ("user_id", "attempted_at");



CREATE INDEX "household_members_household_id_idx" ON "public"."household_members" USING "btree" ("household_id");



CREATE INDEX "leftovers_household_id_idx" ON "public"."leftovers" USING "btree" ("household_id");



CREATE INDEX "leftovers_recipe_id_idx" ON "public"."leftovers" USING "btree" ("recipe_id");



CREATE INDEX "meal_plan_items_household_date_idx" ON "public"."meal_plan_items" USING "btree" ("household_id", "meal_date");



CREATE INDEX "meal_plan_items_leftover_id_idx" ON "public"."meal_plan_items" USING "btree" ("leftover_id");



CREATE INDEX "meal_plan_items_plan_idx" ON "public"."meal_plan_items" USING "btree" ("meal_plan_id");



CREATE INDEX "meal_plan_items_recipe_id_idx" ON "public"."meal_plan_items" USING "btree" ("recipe_id");



CREATE INDEX "pantry_items_household_id_idx" ON "public"."pantry_items" USING "btree" ("household_id");



CREATE INDEX "recipe_feedback_tags_profile_id_idx" ON "public"."recipe_feedback_tags" USING "btree" ("profile_id");



CREATE INDEX "recipe_feedback_tags_recipe_idx" ON "public"."recipe_feedback_tags" USING "btree" ("recipe_id");



CREATE INDEX "recipe_ratings_profile_id_idx" ON "public"."recipe_ratings" USING "btree" ("profile_id");



CREATE INDEX "recipes_household_id_idx" ON "public"."recipes" USING "btree" ("household_id");



CREATE INDEX "shopping_list_items_household_id_idx" ON "public"."shopping_list_items" USING "btree" ("household_id");



CREATE INDEX "shopping_list_items_list_idx" ON "public"."shopping_list_items" USING "btree" ("shopping_list_id");



CREATE INDEX "shopping_list_items_pantry_item_id_idx" ON "public"."shopping_list_items" USING "btree" ("pantry_item_id");



CREATE INDEX "shopping_list_items_recipe_id_idx" ON "public"."shopping_list_items" USING "btree" ("recipe_id");



CREATE INDEX "shopping_lists_created_by_idx" ON "public"."shopping_lists" USING "btree" ("created_by");



CREATE INDEX "shopping_lists_household_idx" ON "public"."shopping_lists" USING "btree" ("household_id", "status");



CREATE INDEX "shops_household_id_idx" ON "public"."shops" USING "btree" ("household_id");



ALTER TABLE ONLY "public"."ai_daily_usage"
    ADD CONSTRAINT "ai_daily_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."household_join_attempts"
    ADD CONSTRAINT "household_join_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."household_members"
    ADD CONSTRAINT "household_members_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."household_members"
    ADD CONSTRAINT "household_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ingredient_prices"
    ADD CONSTRAINT "ingredient_prices_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leftovers"
    ADD CONSTRAINT "leftovers_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leftovers"
    ADD CONSTRAINT "leftovers_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."meal_plan_items"
    ADD CONSTRAINT "meal_plan_items_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meal_plan_items"
    ADD CONSTRAINT "meal_plan_items_leftover_household_fkey" FOREIGN KEY ("leftover_id", "household_id") REFERENCES "public"."leftovers"("id", "household_id") ON DELETE SET NULL ("leftover_id");



ALTER TABLE ONLY "public"."meal_plan_items"
    ADD CONSTRAINT "meal_plan_items_plan_household_fkey" FOREIGN KEY ("meal_plan_id", "household_id") REFERENCES "public"."meal_plans"("id", "household_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meal_plan_items"
    ADD CONSTRAINT "meal_plan_items_recipe_household_fkey" FOREIGN KEY ("recipe_id", "household_id") REFERENCES "public"."recipes"("id", "household_id") ON DELETE SET NULL ("recipe_id");



ALTER TABLE ONLY "public"."meal_plans"
    ADD CONSTRAINT "meal_plans_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pantry_items"
    ADD CONSTRAINT "pantry_items_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_feedback_tags"
    ADD CONSTRAINT "recipe_feedback_tags_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_feedback_tags"
    ADD CONSTRAINT "recipe_feedback_tags_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_ratings"
    ADD CONSTRAINT "recipe_ratings_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipe_ratings"
    ADD CONSTRAINT "recipe_ratings_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipes"
    ADD CONSTRAINT "recipes_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shopping_list_items"
    ADD CONSTRAINT "shopping_list_items_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shopping_list_items"
    ADD CONSTRAINT "shopping_list_items_list_household_fkey" FOREIGN KEY ("shopping_list_id", "household_id") REFERENCES "public"."shopping_lists"("id", "household_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shopping_list_items"
    ADD CONSTRAINT "shopping_list_items_pantry_household_fkey" FOREIGN KEY ("pantry_item_id", "household_id") REFERENCES "public"."pantry_items"("id", "household_id") ON DELETE SET NULL ("pantry_item_id");



ALTER TABLE ONLY "public"."shopping_list_items"
    ADD CONSTRAINT "shopping_list_items_recipe_household_fkey" FOREIGN KEY ("recipe_id", "household_id") REFERENCES "public"."recipes"("id", "household_id") ON DELETE SET NULL ("recipe_id");



ALTER TABLE ONLY "public"."shopping_lists"
    ADD CONSTRAINT "shopping_lists_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."shopping_lists"
    ADD CONSTRAINT "shopping_lists_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shops"
    ADD CONSTRAINT "shops_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE "public"."ai_daily_usage" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "delete own feedback tags" ON "public"."recipe_feedback_tags" FOR DELETE USING (("profile_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "delete own ratings" ON "public"."recipe_ratings" FOR DELETE USING (("profile_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "household ingredient prices" ON "public"."ingredient_prices" USING (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "household leftovers" ON "public"."leftovers" USING (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "household meal plan items" ON "public"."meal_plan_items" USING (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "household meal plans" ON "public"."meal_plans" USING (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "household pantry" ON "public"."pantry_items" USING (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "household recipes" ON "public"."recipes" USING (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "household shopping list items" ON "public"."shopping_list_items" USING (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "household shopping lists" ON "public"."shopping_lists" USING (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "household shops" ON "public"."shops" USING (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK (("household_id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."household_join_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."household_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."households" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ingredient_prices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insert own feedback tags" ON "public"."recipe_feedback_tags" FOR INSERT WITH CHECK ((("profile_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("recipe_id" IN ( SELECT "recipes"."id"
   FROM "public"."recipes"
  WHERE ("recipes"."household_id" IN ( SELECT "household_members"."household_id"
           FROM "public"."household_members"
          WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))))));



CREATE POLICY "insert own household ratings" ON "public"."recipe_ratings" FOR INSERT WITH CHECK ((("profile_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("recipe_id" IN ( SELECT "r"."id"
   FROM ("public"."recipes" "r"
     JOIN "public"."household_members" "hm" ON (("hm"."household_id" = "r"."household_id")))
  WHERE ("hm"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."leftovers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meal_plan_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meal_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "members can read their household" ON "public"."households" FOR SELECT USING (("id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "members can update their household" ON "public"."households" FOR UPDATE USING (("id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK (("id" IN ( SELECT "household_members"."household_id"
   FROM "public"."household_members"
  WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "own profile" ON "public"."profiles" USING ((( SELECT "auth"."uid"() AS "uid") = "id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "id"));



ALTER TABLE "public"."pantry_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "read household feedback tags" ON "public"."recipe_feedback_tags" FOR SELECT USING (("recipe_id" IN ( SELECT "recipes"."id"
   FROM "public"."recipes"
  WHERE ("recipes"."household_id" IN ( SELECT "household_members"."household_id"
           FROM "public"."household_members"
          WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "read household ratings" ON "public"."recipe_ratings" FOR SELECT USING (("recipe_id" IN ( SELECT "recipes"."id"
   FROM "public"."recipes"
  WHERE ("recipes"."household_id" IN ( SELECT "household_members"."household_id"
           FROM "public"."household_members"
          WHERE ("household_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "read own membership rows" ON "public"."household_members" FOR SELECT USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."recipe_feedback_tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recipe_ratings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recipes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."shopping_list_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."shopping_lists" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."shops" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "update own household ratings" ON "public"."recipe_ratings" FOR UPDATE USING (("profile_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK ((("profile_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("recipe_id" IN ( SELECT "r"."id"
   FROM ("public"."recipes" "r"
     JOIN "public"."household_members" "hm" ON (("hm"."household_id" = "r"."household_id")))
  WHERE ("hm"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."consume_ai_quota"("p_kind" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_ai_quota"("p_kind" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."consume_ai_quota"("p_kind" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."join_household"("p_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."join_household"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_household"("p_code" "text") TO "service_role";



GRANT ALL ON TABLE "public"."pantry_items" TO "anon";
GRANT ALL ON TABLE "public"."pantry_items" TO "authenticated";
GRANT ALL ON TABLE "public"."pantry_items" TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_pantry_quantities"("p_changes" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_pantry_quantities"("p_changes" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_pantry_quantities"("p_changes" "jsonb") TO "service_role";



GRANT ALL ON TABLE "public"."ai_daily_usage" TO "anon";
GRANT ALL ON TABLE "public"."ai_daily_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_daily_usage" TO "service_role";



GRANT ALL ON TABLE "public"."household_join_attempts" TO "anon";
GRANT ALL ON TABLE "public"."household_join_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."household_join_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."household_members" TO "anon";
GRANT ALL ON TABLE "public"."household_members" TO "authenticated";
GRANT ALL ON TABLE "public"."household_members" TO "service_role";



GRANT ALL ON TABLE "public"."households" TO "anon";
GRANT ALL ON TABLE "public"."households" TO "authenticated";
GRANT ALL ON TABLE "public"."households" TO "service_role";



GRANT ALL ON TABLE "public"."ingredient_prices" TO "anon";
GRANT ALL ON TABLE "public"."ingredient_prices" TO "authenticated";
GRANT ALL ON TABLE "public"."ingredient_prices" TO "service_role";



GRANT ALL ON TABLE "public"."leftovers" TO "anon";
GRANT ALL ON TABLE "public"."leftovers" TO "authenticated";
GRANT ALL ON TABLE "public"."leftovers" TO "service_role";



GRANT ALL ON TABLE "public"."meal_plan_items" TO "anon";
GRANT ALL ON TABLE "public"."meal_plan_items" TO "authenticated";
GRANT ALL ON TABLE "public"."meal_plan_items" TO "service_role";



GRANT ALL ON TABLE "public"."meal_plans" TO "anon";
GRANT ALL ON TABLE "public"."meal_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."meal_plans" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."recipe_feedback_tags" TO "anon";
GRANT ALL ON TABLE "public"."recipe_feedback_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."recipe_feedback_tags" TO "service_role";



GRANT ALL ON TABLE "public"."recipe_ratings" TO "anon";
GRANT ALL ON TABLE "public"."recipe_ratings" TO "authenticated";
GRANT ALL ON TABLE "public"."recipe_ratings" TO "service_role";



GRANT ALL ON TABLE "public"."recipes" TO "anon";
GRANT ALL ON TABLE "public"."recipes" TO "authenticated";
GRANT ALL ON TABLE "public"."recipes" TO "service_role";



GRANT ALL ON TABLE "public"."shopping_list_items" TO "anon";
GRANT ALL ON TABLE "public"."shopping_list_items" TO "authenticated";
GRANT ALL ON TABLE "public"."shopping_list_items" TO "service_role";



GRANT ALL ON TABLE "public"."shopping_lists" TO "anon";
GRANT ALL ON TABLE "public"."shopping_lists" TO "authenticated";
GRANT ALL ON TABLE "public"."shopping_lists" TO "service_role";



GRANT ALL ON TABLE "public"."shops" TO "anon";
GRANT ALL ON TABLE "public"."shops" TO "authenticated";
GRANT ALL ON TABLE "public"."shops" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







