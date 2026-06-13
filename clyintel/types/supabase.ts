export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_config: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor: string
          actor_detail: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          payload: Json | null
          subscriber_id: string | null
        }
        Insert: {
          action: string
          actor: string
          actor_detail?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          payload?: Json | null
          subscriber_id?: string | null
        }
        Update: {
          action?: string
          actor?: string
          actor_detail?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          payload?: Json | null
          subscriber_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          avg_days_to_pay: number | null
          billing_address: Json | null
          company: string | null
          created_at: string
          email: string | null
          external_id: string | null
          id: string
          name: string
          open_invoice_count: number
          opt_out_email: boolean
          opt_out_sms: boolean
          phone: string | null
          preferred_channel:
            | Database["public"]["Enums"]["communication_channel"]
            | null
          subscriber_id: string
          total_invoiced_cents: number
          total_overdue_cents: number
          total_paid_cents: number
          updated_at: string
        }
        Insert: {
          avg_days_to_pay?: number | null
          billing_address?: Json | null
          company?: string | null
          created_at?: string
          email?: string | null
          external_id?: string | null
          id?: string
          name: string
          open_invoice_count?: number
          opt_out_email?: boolean
          opt_out_sms?: boolean
          phone?: string | null
          preferred_channel?:
            | Database["public"]["Enums"]["communication_channel"]
            | null
          subscriber_id: string
          total_invoiced_cents?: number
          total_overdue_cents?: number
          total_paid_cents?: number
          updated_at?: string
        }
        Update: {
          avg_days_to_pay?: number | null
          billing_address?: Json | null
          company?: string | null
          created_at?: string
          email?: string | null
          external_id?: string | null
          id?: string
          name?: string
          open_invoice_count?: number
          opt_out_email?: boolean
          opt_out_sms?: boolean
          phone?: string | null
          preferred_channel?:
            | Database["public"]["Enums"]["communication_channel"]
            | null
          subscriber_id?: string
          total_invoiced_cents?: number
          total_overdue_cents?: number
          total_paid_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clients_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      communications: {
        Row: {
          ai_intent: string | null
          ai_interpreted: boolean
          ai_response_sent: boolean
          airtable_client_id: string | null
          airtable_subscriber_id: string | null
          body: string | null
          channel: Database["public"]["Enums"]["communication_channel"]
          client_id: string | null
          created_at: string
          delivered_at: string | null
          direction: Database["public"]["Enums"]["communication_direction"]
          discount_offered: number | null
          from_address: string | null
          handoff_triggered: boolean | null
          id: string
          invoice_id: string | null
          mailersend_message_id: string | null
          reply_body: string | null
          reply_received_at: string | null
          sent_at: string | null
          status: string
          subject: string | null
          subscriber_id: string | null
          template_id: string | null
          thread_id: string | null
          to_address: string | null
          twilio_message_sid: string | null
          updated_at: string
        }
        Insert: {
          ai_intent?: string | null
          ai_interpreted?: boolean
          ai_response_sent?: boolean
          airtable_client_id?: string | null
          airtable_subscriber_id?: string | null
          body?: string | null
          channel: Database["public"]["Enums"]["communication_channel"]
          client_id?: string | null
          created_at?: string
          delivered_at?: string | null
          direction?: Database["public"]["Enums"]["communication_direction"]
          discount_offered?: number | null
          from_address?: string | null
          handoff_triggered?: boolean | null
          id?: string
          invoice_id?: string | null
          mailersend_message_id?: string | null
          reply_body?: string | null
          reply_received_at?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          subscriber_id?: string | null
          template_id?: string | null
          thread_id?: string | null
          to_address?: string | null
          twilio_message_sid?: string | null
          updated_at?: string
        }
        Update: {
          ai_intent?: string | null
          ai_interpreted?: boolean
          ai_response_sent?: boolean
          airtable_client_id?: string | null
          airtable_subscriber_id?: string | null
          body?: string | null
          channel?: Database["public"]["Enums"]["communication_channel"]
          client_id?: string | null
          created_at?: string
          delivered_at?: string | null
          direction?: Database["public"]["Enums"]["communication_direction"]
          discount_offered?: number | null
          from_address?: string | null
          handoff_triggered?: boolean | null
          id?: string
          invoice_id?: string | null
          mailersend_message_id?: string | null
          reply_body?: string | null
          reply_received_at?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          subscriber_id?: string | null
          template_id?: string | null
          thread_id?: string | null
          to_address?: string | null
          twilio_message_sid?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "communications_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "templates"
            referencedColumns: ["id"]
          },
        ]
      }
      connected_accounts: {
        Row: {
          access_token: string | null
          connected_at: string
          external_id: string | null
          id: string
          meta: Json | null
          provider: Database["public"]["Enums"]["integration_provider"]
          refresh_token: string | null
          subscriber_id: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          connected_at?: string
          external_id?: string | null
          id?: string
          meta?: Json | null
          provider: Database["public"]["Enums"]["integration_provider"]
          refresh_token?: string | null
          subscriber_id: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          connected_at?: string
          external_id?: string | null
          id?: string
          meta?: Json | null
          provider?: Database["public"]["Enums"]["integration_provider"]
          refresh_token?: string | null
          subscriber_id?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connected_accounts_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_sessions: {
        Row: {
          company_name: string | null
          conversation_history: Json
          created_at: string
          email: string | null
          event_tag: string | null
          id: string
          invoice_number: string | null
          last_reply_at: string | null
          method_used: string | null
          name: string
          phone: string
          scenario: number
          scenario_used: string | null
          submitted_at: string | null
        }
        Insert: {
          company_name?: string | null
          conversation_history?: Json
          created_at?: string
          email?: string | null
          event_tag?: string | null
          id?: string
          invoice_number?: string | null
          last_reply_at?: string | null
          method_used?: string | null
          name: string
          phone: string
          scenario: number
          scenario_used?: string | null
          submitted_at?: string | null
        }
        Update: {
          company_name?: string | null
          conversation_history?: Json
          created_at?: string
          email?: string | null
          event_tag?: string | null
          id?: string
          invoice_number?: string | null
          last_reply_at?: string | null
          method_used?: string | null
          name?: string
          phone?: string
          scenario?: number
          scenario_used?: string | null
          submitted_at?: string | null
        }
        Relationships: []
      }
      invoice_payments: {
        Row: {
          allocated_at: string
          amount_cents: number
          id: string
          invoice_id: string
          payment_id: string
        }
        Insert: {
          allocated_at?: string
          amount_cents?: number
          id?: string
          invoice_id: string
          payment_id: string
        }
        Update: {
          allocated_at?: string
          amount_cents?: number
          id?: string
          invoice_id?: string
          payment_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_payments_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount_cents: number
          amount_outstanding_cents: number | null
          amount_paid_cents: number
          client_id: string
          created_at: string
          currency: string
          description: string | null
          due_date: string | null
          external_id: string | null
          id: string
          in_recovery: boolean
          invoice_number: string | null
          issue_date: string | null
          last_reminder_at: string | null
          line_items: Json | null
          raw_source_data: Json | null
          recovery_started_at: string | null
          reminder_count: number
          source: string | null
          status: Database["public"]["Enums"]["invoice_status"]
          subscriber_id: string
          updated_at: string
        }
        Insert: {
          amount_cents?: number
          amount_outstanding_cents?: number | null
          amount_paid_cents?: number
          client_id: string
          created_at?: string
          currency?: string
          description?: string | null
          due_date?: string | null
          external_id?: string | null
          id?: string
          in_recovery?: boolean
          invoice_number?: string | null
          issue_date?: string | null
          last_reminder_at?: string | null
          line_items?: Json | null
          raw_source_data?: Json | null
          recovery_started_at?: string | null
          reminder_count?: number
          source?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          subscriber_id: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          amount_outstanding_cents?: number | null
          amount_paid_cents?: number
          client_id?: string
          created_at?: string
          currency?: string
          description?: string | null
          due_date?: string | null
          external_id?: string | null
          id?: string
          in_recovery?: boolean
          invoice_number?: string | null
          issue_date?: string | null
          last_reminder_at?: string | null
          line_items?: Json | null
          raw_source_data?: Json | null
          recovery_started_at?: string | null
          reminder_count?: number
          source?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          subscriber_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_cents: number
          client_id: string | null
          created_at: string
          currency: string
          id: string
          meta: Json | null
          paid_at: string | null
          payment_method: string | null
          status: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id: string | null
          stripe_event_id: string | null
          stripe_event_type: string | null
          stripe_payment_intent: string | null
          subscriber_id: string
          updated_at: string
        }
        Insert: {
          amount_cents?: number
          client_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          meta?: Json | null
          paid_at?: string | null
          payment_method?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id?: string | null
          stripe_event_id?: string | null
          stripe_event_type?: string | null
          stripe_payment_intent?: string | null
          subscriber_id: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          client_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          meta?: Json | null
          paid_at?: string | null
          payment_method?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id?: string | null
          stripe_event_id?: string | null
          stripe_event_type?: string | null
          stripe_payment_intent?: string | null
          subscriber_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          advanced_negotiation: boolean
          api_access: boolean
          created_at: string
          display_name: string
          id: string
          monthly_client_score_limit: number | null
          monthly_price_cents: number
          monthly_recovery_limit: number | null
          multi_channel_recovery: boolean
          payg_available: boolean
          predictive_insights: boolean
          revenue_share_rate: number
          stripe_product_id: string | null
          support_level: string
          tier: Database["public"]["Enums"]["plan_tier"]
          updated_at: string
          white_label_reports: boolean
        }
        Insert: {
          advanced_negotiation?: boolean
          api_access?: boolean
          created_at?: string
          display_name: string
          id?: string
          monthly_client_score_limit?: number | null
          monthly_price_cents?: number
          monthly_recovery_limit?: number | null
          multi_channel_recovery?: boolean
          payg_available?: boolean
          predictive_insights?: boolean
          revenue_share_rate?: number
          stripe_product_id?: string | null
          support_level?: string
          tier: Database["public"]["Enums"]["plan_tier"]
          updated_at?: string
          white_label_reports?: boolean
        }
        Update: {
          advanced_negotiation?: boolean
          api_access?: boolean
          created_at?: string
          display_name?: string
          id?: string
          monthly_client_score_limit?: number | null
          monthly_price_cents?: number
          monthly_recovery_limit?: number | null
          multi_channel_recovery?: boolean
          payg_available?: boolean
          predictive_insights?: boolean
          revenue_share_rate?: number
          stripe_product_id?: string | null
          support_level?: string
          tier?: Database["public"]["Enums"]["plan_tier"]
          updated_at?: string
          white_label_reports?: boolean
        }
        Relationships: []
      }
      ptr_scores: {
        Row: {
          ai_model: string | null
          ai_recommendation: string | null
          ai_recommendation_at: string | null
          avg_days_overdue: number | null
          client_id: string
          composite_score: number | null
          counted_toward_limit: boolean
          created_at: string
          dispute_rate: number | null
          id: string
          non_response_rate: number | null
          outstanding_amount_cents: number | null
          payment_history_score: number | null
          risk_level: Database["public"]["Enums"]["ptr_risk_level"]
          score_date: string
          score_month: string
          subscriber_id: string
        }
        Insert: {
          ai_model?: string | null
          ai_recommendation?: string | null
          ai_recommendation_at?: string | null
          avg_days_overdue?: number | null
          client_id: string
          composite_score?: number | null
          counted_toward_limit?: boolean
          created_at?: string
          dispute_rate?: number | null
          id?: string
          non_response_rate?: number | null
          outstanding_amount_cents?: number | null
          payment_history_score?: number | null
          risk_level?: Database["public"]["Enums"]["ptr_risk_level"]
          score_date?: string
          score_month: string
          subscriber_id: string
        }
        Update: {
          ai_model?: string | null
          ai_recommendation?: string | null
          ai_recommendation_at?: string | null
          avg_days_overdue?: number | null
          client_id?: string
          composite_score?: number | null
          counted_toward_limit?: boolean
          created_at?: string
          dispute_rate?: number | null
          id?: string
          non_response_rate?: number | null
          outstanding_amount_cents?: number | null
          payment_history_score?: number | null
          risk_level?: Database["public"]["Enums"]["ptr_risk_level"]
          score_date?: string
          score_month?: string
          subscriber_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ptr_scores_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ptr_scores_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      recovery_attempts: {
        Row: {
          amount_recovered_cents: number | null
          attempt_number: number
          channel: Database["public"]["Enums"]["communication_channel"]
          client_id: string
          communication_id: string | null
          counted_toward_limit: boolean
          created_at: string
          id: string
          invoice_id: string
          notes: string | null
          resolution: string | null
          resolved_at: string | null
          revenue_share_amount_cents: number | null
          revenue_share_rate: number | null
          scheduled_at: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["recovery_status"]
          subscriber_id: string
          updated_at: string
        }
        Insert: {
          amount_recovered_cents?: number | null
          attempt_number?: number
          channel: Database["public"]["Enums"]["communication_channel"]
          client_id: string
          communication_id?: string | null
          counted_toward_limit?: boolean
          created_at?: string
          id?: string
          invoice_id: string
          notes?: string | null
          resolution?: string | null
          resolved_at?: string | null
          revenue_share_amount_cents?: number | null
          revenue_share_rate?: number | null
          scheduled_at?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["recovery_status"]
          subscriber_id: string
          updated_at?: string
        }
        Update: {
          amount_recovered_cents?: number | null
          attempt_number?: number
          channel?: Database["public"]["Enums"]["communication_channel"]
          client_id?: string
          communication_id?: string | null
          counted_toward_limit?: boolean
          created_at?: string
          id?: string
          invoice_id?: string
          notes?: string | null
          resolution?: string | null
          resolved_at?: string | null
          revenue_share_amount_cents?: number | null
          revenue_share_rate?: number | null
          scheduled_at?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["recovery_status"]
          subscriber_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recovery_attempts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recovery_attempts_communication_id_fkey"
            columns: ["communication_id"]
            isOneToOne: false
            referencedRelation: "communications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recovery_attempts_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recovery_attempts_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      recovery_links: {
        Row: {
          created_at: string
          id: string
          invoice_id: string
          link_expires_at: string | null
          link_status: string
          link_type: string
          payment_link_url: string | null
          settlement_amount_cents: number | null
          stripe_checkout_session_id: string | null
          subscriber_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          invoice_id: string
          link_expires_at?: string | null
          link_status?: string
          link_type: string
          payment_link_url?: string | null
          settlement_amount_cents?: number | null
          stripe_checkout_session_id?: string | null
          subscriber_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          invoice_id?: string
          link_expires_at?: string | null
          link_status?: string
          link_type?: string
          payment_link_url?: string | null
          settlement_amount_cents?: number | null
          stripe_checkout_session_id?: string | null
          subscriber_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recovery_links_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recovery_links_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      payout_accounts: {
        Row: {
          account_type: string
          charges_enabled: boolean
          created_at: string
          id: string
          last_link_disposition: string | null
          onboarding_status: string
          payouts_enabled: boolean
          provider: string
          provider_account_id: string | null
          subscriber_id: string
          updated_at: string
        }
        Insert: {
          account_type?: string
          charges_enabled?: boolean
          created_at?: string
          id?: string
          last_link_disposition?: string | null
          onboarding_status?: string
          payouts_enabled?: boolean
          provider?: string
          provider_account_id?: string | null
          subscriber_id: string
          updated_at?: string
        }
        Update: {
          account_type?: string
          charges_enabled?: boolean
          created_at?: string
          id?: string
          last_link_disposition?: string | null
          onboarding_status?: string
          payouts_enabled?: boolean
          provider?: string
          provider_account_id?: string | null
          subscriber_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payout_accounts_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      subscribers: {
        Row: {
          billing_path: Database["public"]["Enums"]["billing_path"]
          business_name: string
          client_scores_used_this_month: number
          contact_name: string | null
          created_at: string
          discount_expires_at: string | null
          email: string
          flag_advanced_negotiation: boolean
          flag_api_access: boolean
          flag_multi_channel: boolean
          flag_predictive_insights: boolean
          flag_white_label: boolean
          id: string
          phone: string | null
          plan_id: string
          qbo_access_token: string | null
          qbo_realm_id: string | null
          qbo_refresh_token: string | null
          qbo_token_expires_at: string | null
          recoveries_used_this_month: number
          stripe_coupon_id: string | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_status: string
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          billing_path?: Database["public"]["Enums"]["billing_path"]
          business_name: string
          client_scores_used_this_month?: number
          contact_name?: string | null
          created_at?: string
          discount_expires_at?: string | null
          email: string
          flag_advanced_negotiation?: boolean
          flag_api_access?: boolean
          flag_multi_channel?: boolean
          flag_predictive_insights?: boolean
          flag_white_label?: boolean
          id?: string
          phone?: string | null
          plan_id: string
          qbo_access_token?: string | null
          qbo_realm_id?: string | null
          qbo_refresh_token?: string | null
          qbo_token_expires_at?: string | null
          recoveries_used_this_month?: number
          stripe_coupon_id?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          billing_path?: Database["public"]["Enums"]["billing_path"]
          business_name?: string
          client_scores_used_this_month?: number
          contact_name?: string | null
          created_at?: string
          discount_expires_at?: string | null
          email?: string
          flag_advanced_negotiation?: boolean
          flag_api_access?: boolean
          flag_multi_channel?: boolean
          flag_predictive_insights?: boolean
          flag_white_label?: boolean
          id?: string
          phone?: string | null
          plan_id?: string
          qbo_access_token?: string | null
          qbo_realm_id?: string | null
          qbo_refresh_token?: string | null
          qbo_token_expires_at?: string | null
          recoveries_used_this_month?: number
          stripe_coupon_id?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscribers_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      templates: {
        Row: {
          body: string
          channel: Database["public"]["Enums"]["communication_channel"]
          created_at: string
          id: string
          is_active: boolean
          is_ai_generated: boolean
          is_system_default: boolean
          name: string
          subject: string | null
          subscriber_id: string | null
          trigger_days_offset: number | null
          trigger_event: string
          updated_at: string
        }
        Insert: {
          body: string
          channel: Database["public"]["Enums"]["communication_channel"]
          created_at?: string
          id?: string
          is_active?: boolean
          is_ai_generated?: boolean
          is_system_default?: boolean
          name: string
          subject?: string | null
          subscriber_id?: string | null
          trigger_days_offset?: number | null
          trigger_event: string
          updated_at?: string
        }
        Update: {
          body?: string
          channel?: Database["public"]["Enums"]["communication_channel"]
          created_at?: string
          id?: string
          is_active?: boolean
          is_ai_generated?: boolean
          is_system_default?: boolean
          name?: string
          subject?: string | null
          subscriber_id?: string | null
          trigger_days_offset?: number | null
          trigger_event?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "templates_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      billing_path: "revenue_share"
      communication_channel: "email" | "sms" | "voice"
      communication_direction: "outbound" | "inbound"
      integration_provider: "stripe" | "quickbooks" | "twilio" | "mailersend"
      invoice_status:
        | "draft"
        | "sent"
        | "partial"
        | "paid"
        | "overdue"
        | "in_recovery"
        | "written_off"
      payment_status: "pending" | "succeeded" | "failed" | "refunded"
      plan_tier: "free" | "starter" | "pro" | "plus" | "enterprise"
      ptr_risk_level: "low" | "medium" | "high" | "critical"
      recovery_status:
        | "scheduled"
        | "sent"
        | "replied"
        | "resolved"
        | "failed"
        | "skipped"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      billing_path: ["revenue_share"],
      communication_channel: ["email", "sms", "voice"],
      communication_direction: ["outbound", "inbound"],
      integration_provider: ["stripe", "quickbooks", "twilio", "mailersend"],
      invoice_status: [
        "draft",
        "sent",
        "partial",
        "paid",
        "overdue",
        "in_recovery",
        "written_off",
      ],
      payment_status: ["pending", "succeeded", "failed", "refunded"],
      plan_tier: ["free", "starter", "pro", "plus", "enterprise"],
      ptr_risk_level: ["low", "medium", "high", "critical"],
      recovery_status: [
        "scheduled",
        "sent",
        "replied",
        "resolved",
        "failed",
        "skipped",
      ],
    },
  },
} as const
