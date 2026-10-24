-- Baseline: the full schema as of the introduction of tracked migrations,
-- exported from shared/schema.ts with `drizzle-kit export --sql`.
-- Databases that already contain these tables (local dev, test) are
-- marked as baselined by script/migrate.ts instead of re-running this.

CREATE TABLE "audit_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" varchar,
	"action" varchar NOT NULL,
	"target_type" varchar,
	"target_id" varchar,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now()
);

CREATE TABLE "email_verification_tokens" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"token_hash" varchar NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "email_verification_tokens_token_hash_unique" UNIQUE("token_hash")
);

CREATE TABLE "password_reset_tokens" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar NOT NULL,
	"token_hash" varchar NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);

CREATE TABLE "user_devices" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"device_id" varchar NOT NULL,
	"name" text,
	"platform" text,
	"browser" text,
	"first_seen_at" timestamp DEFAULT now(),
	"last_seen_at" timestamp DEFAULT now(),
	"revoked_at" timestamp,
	CONSTRAINT "user_devices_device_id_unique" UNIQUE("device_id")
);

CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" varchar NOT NULL,
	"password_hash" varchar NOT NULL,
	"role" varchar DEFAULT 'patient' NOT NULL,
	"state" varchar,
	"phone" varchar,
	"emergency_contact_name" text,
	"emergency_contact_phone" varchar,
	"allergies_text" text,
	"emergency_notes" text,
	"created_at" timestamp DEFAULT now(),
	"deactivated_at" timestamp,
	"email_verified_at" timestamp,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);

CREATE TABLE "doctor_applications" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" varchar NOT NULL,
	"password_hash" varchar NOT NULL,
	"license_number" varchar NOT NULL,
	"licensed_states" jsonb NOT NULL,
	"npi_number" varchar,
	"specialty" varchar NOT NULL,
	"phone" varchar NOT NULL,
	"bio" text,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"reviewer_notes" text,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now()
);

CREATE TABLE "doctor_profiles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"name" text NOT NULL,
	"specialty" varchar NOT NULL,
	"state" varchar NOT NULL,
	"license_number" varchar,
	"npi_number" varchar,
	"phone" varchar NOT NULL,
	"bio" text,
	"active" boolean DEFAULT true NOT NULL,
	"source" varchar DEFAULT 'seed' NOT NULL,
	"created_at" timestamp DEFAULT now()
);

CREATE TABLE "messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pairing_request_id" varchar NOT NULL,
	"sender_user_id" varchar NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);

CREATE TABLE "pairing_requests" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_user_id" varchar NOT NULL,
	"doctor_profile_id" varchar NOT NULL,
	"symptom_report_id" varchar,
	"status" varchar DEFAULT 'requested' NOT NULL,
	"relationship_label" varchar,
	"requested_at" timestamp DEFAULT now(),
	"responded_at" timestamp
);

CREATE TABLE "symptom_reports" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_user_id" varchar NOT NULL,
	"state" varchar NOT NULL,
	"symptom_text" text NOT NULL,
	"input_method" varchar NOT NULL,
	"transcription_provider" varchar,
	"created_at" timestamp DEFAULT now()
);

CREATE TABLE "ai_messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"role" varchar NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);

CREATE TABLE "appointments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pairing_request_id" varchar NOT NULL,
	"patient_user_id" varchar NOT NULL,
	"doctor_profile_id" varchar NOT NULL,
	"type" varchar DEFAULT 'Video Visit' NOT NULL,
	"reason" text NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"duration_minutes" integer DEFAULT 30 NOT NULL,
	"status" varchar DEFAULT 'requested' NOT NULL,
	"questions_for_doctor" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"doctor_notes" text,
	"follow_up_instructions" text,
	"follow_up_date" timestamp,
	"created_at" timestamp DEFAULT now()
);

CREATE TABLE "documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_user_id" varchar NOT NULL,
	"uploaded_by_user_id" varchar NOT NULL,
	"title" text NOT NULL,
	"category" varchar DEFAULT 'Other' NOT NULL,
	"file_name" text,
	"file_path" text,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);

CREATE TABLE "follow_up_tasks" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_user_id" varchar NOT NULL,
	"appointment_id" varchar,
	"doctor_profile_id" varchar,
	"title" text NOT NULL,
	"detail" text,
	"due_date" timestamp,
	"status" varchar DEFAULT 'open' NOT NULL,
	"source_type" varchar DEFAULT 'manual' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"completed_at" timestamp
);

CREATE TABLE "medication_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"medication_id" varchar NOT NULL,
	"patient_user_id" varchar NOT NULL,
	"dose_date" varchar NOT NULL,
	"dose_time" varchar NOT NULL,
	"status" varchar DEFAULT 'taken' NOT NULL,
	"recorded_at" timestamp DEFAULT now()
);

CREATE TABLE "medications" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_user_id" varchar NOT NULL,
	"prescription_id" varchar NOT NULL,
	"name" text NOT NULL,
	"instructions" text NOT NULL,
	"schedule_times" jsonb NOT NULL,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now()
);

CREATE TABLE "pharmacies" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"city" varchar NOT NULL,
	"state" varchar NOT NULL,
	"zip" varchar NOT NULL,
	"phone" varchar NOT NULL,
	"hours_text" text,
	"delivery_available" boolean DEFAULT true NOT NULL,
	"pickup_available" boolean DEFAULT true NOT NULL,
	"is_mail_order" boolean DEFAULT false NOT NULL,
	"distance_miles" integer,
	"created_at" timestamp DEFAULT now()
);

CREATE TABLE "pharmacy_orders" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_id" varchar NOT NULL,
	"patient_user_id" varchar NOT NULL,
	"pharmacy_id" varchar NOT NULL,
	"fulfillment_type" varchar NOT NULL,
	"delivery_address" text,
	"status" varchar DEFAULT 'received' NOT NULL,
	"status_history" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now()
);

CREATE TABLE "prescriptions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pairing_request_id" varchar NOT NULL,
	"patient_user_id" varchar NOT NULL,
	"doctor_profile_id" varchar NOT NULL,
	"appointment_id" varchar,
	"medication_name" text NOT NULL,
	"instructions" text NOT NULL,
	"frequency_per_day" integer DEFAULT 1 NOT NULL,
	"duration_days" integer,
	"quantity" integer,
	"refills_allowed" integer DEFAULT 0 NOT NULL,
	"refills_used" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"status" varchar DEFAULT 'active' NOT NULL,
	"start_date" timestamp DEFAULT now() NOT NULL,
	"end_date" timestamp,
	"created_at" timestamp DEFAULT now()
);

CREATE TABLE "sharing_grants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_user_id" varchar NOT NULL,
	"shared_with_doctor_profile_id" varchar NOT NULL,
	"share_medications" boolean DEFAULT false NOT NULL,
	"share_documents" boolean DEFAULT false NOT NULL,
	"share_appointments" boolean DEFAULT false NOT NULL,
	"share_full_history" boolean DEFAULT false NOT NULL,
	"granted_at" timestamp DEFAULT now(),
	"revoked_at" timestamp
);

CREATE TABLE "care_circle_members" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_user_id" varchar NOT NULL,
	"caregiver_user_id" varchar,
	"name" text NOT NULL,
	"invite_email" varchar NOT NULL,
	"relationship_label" varchar NOT NULL,
	"permission_medication_status" boolean DEFAULT true NOT NULL,
	"permission_appointments" boolean DEFAULT true NOT NULL,
	"permission_delivery_status" boolean DEFAULT true NOT NULL,
	"permission_documents" boolean DEFAULT false NOT NULL,
	"permission_full_records" boolean DEFAULT false NOT NULL,
	"status" varchar DEFAULT 'invited' NOT NULL,
	"token_hash" varchar,
	"invited_at" timestamp DEFAULT now(),
	"responded_at" timestamp,
	CONSTRAINT "care_circle_members_token_hash_unique" UNIQUE("token_hash")
);

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "doctor_applications" ADD CONSTRAINT "doctor_applications_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "messages" ADD CONSTRAINT "messages_pairing_request_id_pairing_requests_id_fk" FOREIGN KEY ("pairing_request_id") REFERENCES "public"."pairing_requests"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pairing_requests" ADD CONSTRAINT "pairing_requests_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pairing_requests" ADD CONSTRAINT "pairing_requests_doctor_profile_id_doctor_profiles_id_fk" FOREIGN KEY ("doctor_profile_id") REFERENCES "public"."doctor_profiles"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pairing_requests" ADD CONSTRAINT "pairing_requests_symptom_report_id_symptom_reports_id_fk" FOREIGN KEY ("symptom_report_id") REFERENCES "public"."symptom_reports"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "symptom_reports" ADD CONSTRAINT "symptom_reports_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_pairing_request_id_pairing_requests_id_fk" FOREIGN KEY ("pairing_request_id") REFERENCES "public"."pairing_requests"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_profile_id_doctor_profiles_id_fk" FOREIGN KEY ("doctor_profile_id") REFERENCES "public"."doctor_profiles"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "documents" ADD CONSTRAINT "documents_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_doctor_profile_id_doctor_profiles_id_fk" FOREIGN KEY ("doctor_profile_id") REFERENCES "public"."doctor_profiles"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medication_logs" ADD CONSTRAINT "medication_logs_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medication_logs" ADD CONSTRAINT "medication_logs_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medications" ADD CONSTRAINT "medications_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "medications" ADD CONSTRAINT "medications_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pharmacy_orders" ADD CONSTRAINT "pharmacy_orders_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pharmacy_orders" ADD CONSTRAINT "pharmacy_orders_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pharmacy_orders" ADD CONSTRAINT "pharmacy_orders_pharmacy_id_pharmacies_id_fk" FOREIGN KEY ("pharmacy_id") REFERENCES "public"."pharmacies"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_pairing_request_id_pairing_requests_id_fk" FOREIGN KEY ("pairing_request_id") REFERENCES "public"."pairing_requests"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_doctor_profile_id_doctor_profiles_id_fk" FOREIGN KEY ("doctor_profile_id") REFERENCES "public"."doctor_profiles"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sharing_grants" ADD CONSTRAINT "sharing_grants_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sharing_grants" ADD CONSTRAINT "sharing_grants_shared_with_doctor_profile_id_doctor_profiles_id_fk" FOREIGN KEY ("shared_with_doctor_profile_id") REFERENCES "public"."doctor_profiles"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "care_circle_members" ADD CONSTRAINT "care_circle_members_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "care_circle_members" ADD CONSTRAINT "care_circle_members_caregiver_user_id_users_id_fk" FOREIGN KEY ("caregiver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "idx_audit_logs_created" ON "audit_logs" USING btree ("created_at");
CREATE INDEX "idx_user_devices_user" ON "user_devices" USING btree ("user_id");
CREATE INDEX "idx_doctor_applications_status" ON "doctor_applications" USING btree ("status");
CREATE INDEX "idx_doctor_profiles_state_specialty" ON "doctor_profiles" USING btree ("state","specialty");
CREATE INDEX "idx_messages_pairing" ON "messages" USING btree ("pairing_request_id","created_at");
CREATE INDEX "idx_pairing_requests_patient" ON "pairing_requests" USING btree ("patient_user_id");
CREATE INDEX "idx_pairing_requests_doctor" ON "pairing_requests" USING btree ("doctor_profile_id");
CREATE UNIQUE INDEX "idx_pairing_requests_one_open_per_pair" ON "pairing_requests" USING btree ("patient_user_id","doctor_profile_id") WHERE "pairing_requests"."status" IN ('requested', 'accepted');
CREATE INDEX "idx_symptom_reports_patient" ON "symptom_reports" USING btree ("patient_user_id");
CREATE INDEX "idx_ai_messages_user" ON "ai_messages" USING btree ("user_id","created_at");
CREATE INDEX "idx_appointments_patient" ON "appointments" USING btree ("patient_user_id","scheduled_at");
CREATE INDEX "idx_appointments_doctor" ON "appointments" USING btree ("doctor_profile_id","scheduled_at");
CREATE INDEX "idx_documents_patient" ON "documents" USING btree ("patient_user_id","created_at");
CREATE INDEX "idx_follow_up_tasks_patient" ON "follow_up_tasks" USING btree ("patient_user_id","status");
CREATE UNIQUE INDEX "idx_medication_logs_slot" ON "medication_logs" USING btree ("medication_id","dose_date","dose_time");
CREATE INDEX "idx_medication_logs_patient_date" ON "medication_logs" USING btree ("patient_user_id","dose_date");
CREATE UNIQUE INDEX "idx_medications_one_per_prescription" ON "medications" USING btree ("prescription_id");
CREATE INDEX "idx_medications_patient" ON "medications" USING btree ("patient_user_id","active");
CREATE INDEX "idx_pharmacy_orders_patient" ON "pharmacy_orders" USING btree ("patient_user_id","created_at");
CREATE INDEX "idx_prescriptions_patient" ON "prescriptions" USING btree ("patient_user_id","created_at");
CREATE INDEX "idx_sharing_grants_patient" ON "sharing_grants" USING btree ("patient_user_id");
CREATE UNIQUE INDEX "idx_sharing_grants_one_active_per_doctor" ON "sharing_grants" USING btree ("patient_user_id","shared_with_doctor_profile_id") WHERE "sharing_grants"."revoked_at" is null;
CREATE INDEX "idx_care_circle_patient" ON "care_circle_members" USING btree ("patient_user_id");
CREATE INDEX "idx_care_circle_caregiver" ON "care_circle_members" USING btree ("caregiver_user_id");
