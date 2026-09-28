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
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      adapter_requests: {
        Row: {
          created_at: string
          email: string
          id: string
          notes: string | null
          provider_name: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          notes?: string | null
          provider_name: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          notes?: string | null
          provider_name?: string
        }
        Relationships: []
      }
      agent_invitation_tokens: {
        Row: {
          agent_member_id: string
          created_at: string
          created_from_ip: string | null
          created_from_ua: string | null
          expires_at: string
          id: string
          owner_user_id: string
          redeemed_at: string | null
          revoked_at: string | null
          token_hash: string
        }
        Insert: {
          agent_member_id: string
          created_at?: string
          created_from_ip?: string | null
          created_from_ua?: string | null
          expires_at: string
          id?: string
          owner_user_id: string
          redeemed_at?: string | null
          revoked_at?: string | null
          token_hash: string
        }
        Update: {
          agent_member_id?: string
          created_at?: string
          created_from_ip?: string | null
          created_from_ua?: string | null
          expires_at?: string
          id?: string
          owner_user_id?: string
          redeemed_at?: string | null
          revoked_at?: string | null
          token_hash?: string
        }
        Relationships: []
      }
      agent_members: {
        Row: {
          activated_at: string | null
          agent_kind: Database["public"]["Enums"]["agent_kind"]
          agent_name: string
          id: string
          identity_pubkey: string | null
          invited_at: string
          kem_pubkey: string | null
          last_activity_at: string | null
          notes: string | null
          owner_user_id: string
          revoked_at: string | null
          role: Database["public"]["Enums"]["agent_role"]
          shadow_user_id: string | null
        }
        Insert: {
          activated_at?: string | null
          agent_kind: Database["public"]["Enums"]["agent_kind"]
          agent_name: string
          id?: string
          identity_pubkey?: string | null
          invited_at?: string
          kem_pubkey?: string | null
          last_activity_at?: string | null
          notes?: string | null
          owner_user_id: string
          revoked_at?: string | null
          role?: Database["public"]["Enums"]["agent_role"]
          shadow_user_id?: string | null
        }
        Update: {
          activated_at?: string | null
          agent_kind?: Database["public"]["Enums"]["agent_kind"]
          agent_name?: string
          id?: string
          identity_pubkey?: string | null
          invited_at?: string
          kem_pubkey?: string | null
          last_activity_at?: string | null
          notes?: string | null
          owner_user_id?: string
          revoked_at?: string | null
          role?: Database["public"]["Enums"]["agent_role"]
          shadow_user_id?: string | null
        }
        Relationships: []
      }
      apps: {
        Row: {
          client_secret: string
          created_at: string
          description: string | null
          id: string
          name: string
          redirect_uri_pattern: string | null
          slug: string
          updated_at: string
        }
        Insert: {
          client_secret: string
          created_at?: string
          description?: string | null
          id?: string
          name: string
          redirect_uri_pattern?: string | null
          slug: string
          updated_at?: string
        }
        Update: {
          client_secret?: string
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          redirect_uri_pattern?: string | null
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      audit_entries: {
        Row: {
          action: string
          actor_member_id: string | null
          actor_user_id: string | null
          after_ciphertext: string | null
          before_ciphertext: string | null
          chain_height: number
          client_ip: string | null
          client_user_agent: string | null
          created_at: string
          id: string
          prev_hash: string
          reason: string | null
          resource_id: string | null
          resource_type: string | null
          result: string | null
          this_hash: string
        }
        Insert: {
          action: string
          actor_member_id?: string | null
          actor_user_id?: string | null
          after_ciphertext?: string | null
          before_ciphertext?: string | null
          chain_height?: number
          client_ip?: string | null
          client_user_agent?: string | null
          created_at?: string
          id?: string
          prev_hash: string
          reason?: string | null
          resource_id?: string | null
          resource_type?: string | null
          result?: string | null
          this_hash: string
        }
        Update: {
          action?: string
          actor_member_id?: string | null
          actor_user_id?: string | null
          after_ciphertext?: string | null
          before_ciphertext?: string | null
          chain_height?: number
          client_ip?: string | null
          client_user_agent?: string | null
          created_at?: string
          id?: string
          prev_hash?: string
          reason?: string | null
          resource_id?: string | null
          resource_type?: string | null
          result?: string | null
          this_hash?: string
        }
        Relationships: []
      }
      audit_events: {
        Row: {
          actor_user_id: string | null
          created_at: string
          customer_id: string | null
          encrypted_payload: string | null
          encrypted_payload_kv: number | null
          event_type: string
          id: string
          payload: Json
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          customer_id?: string | null
          encrypted_payload?: string | null
          encrypted_payload_kv?: number | null
          event_type: string
          id?: string
          payload?: Json
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          customer_id?: string | null
          encrypted_payload?: string | null
          encrypted_payload_kv?: number | null
          event_type?: string
          id?: string
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_state: {
        Row: {
          closed_at: string | null
          created_at: string
          id: string
          outpoint_bidx: string
          seal_version: number
          sealed_ct: string
          sealed_iv: string
          update_id: number
          user_id: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          id?: string
          outpoint_bidx: string
          seal_version: number
          sealed_ct: string
          sealed_iv: string
          update_id: number
          user_id: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          id?: string
          outpoint_bidx?: string
          seal_version?: number
          sealed_ct?: string
          sealed_iv?: string
          update_id?: number
          user_id?: string
        }
        Relationships: []
      }
      connections: {
        Row: {
          account_emitted_id: string | null
          account_fingerprint: string | null
          created_at: string
          credentials_key_version: number
          data_key_generation: number
          encrypted_credentials: string
          encrypted_label: string | null
          encrypted_last_error: string | null
          id: string
          last_sync_at: string | null
          last_sync_cursor: string | null
          provider_type: string
          quiltt_connection_id: string | null
          status: string
          strike_bad_sig_count: number
          strike_needs_resubscribe: boolean
          strike_subscription_checked_at: string | null
          strike_subscription_id: string | null
          strike_webhook_secret: string | null
          subaccount_id: string
          updated_at: string
        }
        Insert: {
          account_emitted_id?: string | null
          account_fingerprint?: string | null
          created_at?: string
          credentials_key_version?: number
          data_key_generation?: number
          encrypted_credentials: string
          encrypted_label?: string | null
          encrypted_last_error?: string | null
          id?: string
          last_sync_at?: string | null
          last_sync_cursor?: string | null
          provider_type: string
          quiltt_connection_id?: string | null
          status?: string
          strike_bad_sig_count?: number
          strike_needs_resubscribe?: boolean
          strike_subscription_checked_at?: string | null
          strike_subscription_id?: string | null
          strike_webhook_secret?: string | null
          subaccount_id: string
          updated_at?: string
        }
        Update: {
          account_emitted_id?: string | null
          account_fingerprint?: string | null
          created_at?: string
          credentials_key_version?: number
          data_key_generation?: number
          encrypted_credentials?: string
          encrypted_label?: string | null
          encrypted_last_error?: string | null
          id?: string
          last_sync_at?: string | null
          last_sync_cursor?: string | null
          provider_type?: string
          quiltt_connection_id?: string | null
          status?: string
          strike_bad_sig_count?: number
          strike_needs_resubscribe?: boolean
          strike_subscription_checked_at?: string | null
          strike_subscription_id?: string | null
          strike_webhook_secret?: string | null
          subaccount_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connections_subaccount_id_fkey"
            columns: ["subaccount_id"]
            isOneToOne: false
            referencedRelation: "subaccounts"
            referencedColumns: ["id"]
          },
        ]
      }
      consumed_refresh_nonces: {
        Row: {
          agent_member_id: string
          consumed_at: string
          id: string
          payload_hash: string
        }
        Insert: {
          agent_member_id: string
          consumed_at?: string
          id?: string
          payload_hash: string
        }
        Update: {
          agent_member_id?: string
          consumed_at?: string
          id?: string
          payload_hash?: string
        }
        Relationships: []
      }
      customer_recovery_shares: {
        Row: {
          created_at: string
          customer_id: string
          notes: string | null
          shamir_threshold: number
          shamir_total_shares: number
          share_ciphertext: string
          share_index: number
          team_key_version: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          notes?: string | null
          shamir_threshold?: number
          shamir_total_shares?: number
          share_ciphertext: string
          share_index?: number
          team_key_version?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          notes?: string | null
          shamir_threshold?: number
          shamir_total_shares?: number
          share_ciphertext?: string
          share_index?: number
          team_key_version?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_recovery_shares_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_vault_meta: {
        Row: {
          created_at: string
          customer_id: string
          enc_mek_ciphertext: string | null
          kdf_algorithm: string
          kdf_params: Json
          kem_public_key: string | null
          kem_secret_wrapped: string | null
          multi_unlock_confirmed_at: string | null
          pqc_key_version: number
          recovery_ciphertext: string | null
          sig_public_key: string | null
          sig_secret_wrapped: string | null
          updated_at: string
          vault_key_version: number
          vault_mode: string
          vault_salt: string
          vault_verifier_ciphertext: string
          workspace_key_id: string | null
        }
        Insert: {
          created_at?: string
          customer_id: string
          enc_mek_ciphertext?: string | null
          kdf_algorithm?: string
          kdf_params?: Json
          kem_public_key?: string | null
          kem_secret_wrapped?: string | null
          multi_unlock_confirmed_at?: string | null
          pqc_key_version?: number
          recovery_ciphertext?: string | null
          sig_public_key?: string | null
          sig_secret_wrapped?: string | null
          updated_at?: string
          vault_key_version?: number
          vault_mode?: string
          vault_salt: string
          vault_verifier_ciphertext: string
          workspace_key_id?: string | null
        }
        Update: {
          created_at?: string
          customer_id?: string
          enc_mek_ciphertext?: string | null
          kdf_algorithm?: string
          kdf_params?: Json
          kem_public_key?: string | null
          kem_secret_wrapped?: string | null
          multi_unlock_confirmed_at?: string | null
          pqc_key_version?: number
          recovery_ciphertext?: string | null
          sig_public_key?: string | null
          sig_secret_wrapped?: string | null
          updated_at?: string
          vault_key_version?: number
          vault_mode?: string
          vault_salt?: string
          vault_verifier_ciphertext?: string
          workspace_key_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_vault_meta_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          analytics_id: string
          auth_user_id: string | null
          created_at: string
          customer_type: string
          email: string
          encrypted_payload: string | null
          encrypted_payload_kv: number | null
          id: string
          name: string
          plan: string
          status: string
          updated_at: string
        }
        Insert: {
          analytics_id?: string
          auth_user_id?: string | null
          created_at?: string
          customer_type: string
          email: string
          encrypted_payload?: string | null
          encrypted_payload_kv?: number | null
          id?: string
          name: string
          plan: string
          status?: string
          updated_at?: string
        }
        Update: {
          analytics_id?: string
          auth_user_id?: string | null
          created_at?: string
          customer_type?: string
          email?: string
          encrypted_payload?: string | null
          encrypted_payload_kv?: number | null
          id?: string
          name?: string
          plan?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      data_keys: {
        Row: {
          created_at: string
          data_key_id: string
          owner_user_id: string
        }
        Insert: {
          created_at?: string
          data_key_id: string
          owner_user_id: string
        }
        Update: {
          created_at?: string
          data_key_id?: string
          owner_user_id?: string
        }
        Relationships: []
      }
      discovery_sessions: {
        Row: {
          account_key: string
          created_at: string
          currency: string
          expires_at: string
          external_wallet_id: string
          id: string
          provider_type: string
          widget_session_id: string
        }
        Insert: {
          account_key: string
          created_at?: string
          currency: string
          expires_at: string
          external_wallet_id: string
          id?: string
          provider_type: string
          widget_session_id: string
        }
        Update: {
          account_key?: string
          created_at?: string
          currency?: string
          expires_at?: string
          external_wallet_id?: string
          id?: string
          provider_type?: string
          widget_session_id?: string
        }
        Relationships: []
      }
      drain_alert_state: {
        Row: {
          id: number
          last_attempt_at: string | null
          last_error: string | null
          last_notified_at: string | null
          last_signal_snapshot: Json | null
        }
        Insert: {
          id?: number
          last_attempt_at?: string | null
          last_error?: string | null
          last_notified_at?: string | null
          last_signal_snapshot?: Json | null
        }
        Update: {
          id?: number
          last_attempt_at?: string | null
          last_error?: string | null
          last_notified_at?: string | null
          last_signal_snapshot?: Json | null
        }
        Relationships: []
      }
      encrypted_transactions: {
        Row: {
          connection_id: string
          data_key_generation: number
          encrypted_payload: string
          external_id: string
          fetched_at: string
          hmac_counterparty: string | null
          hmac_direction: string | null
          hmac_type: string | null
          id: string
          occurred_at: string
          payload_key_version: number
          sealed_alg: string | null
          sealed_under: string
        }
        Insert: {
          connection_id: string
          data_key_generation?: number
          encrypted_payload: string
          external_id: string
          fetched_at?: string
          hmac_counterparty?: string | null
          hmac_direction?: string | null
          hmac_type?: string | null
          id?: string
          occurred_at: string
          payload_key_version?: number
          sealed_alg?: string | null
          sealed_under?: string
        }
        Update: {
          connection_id?: string
          data_key_generation?: number
          encrypted_payload?: string
          external_id?: string
          fetched_at?: string
          hmac_counterparty?: string | null
          hmac_direction?: string | null
          hmac_type?: string | null
          id?: string
          occurred_at?: string
          payload_key_version?: number
          sealed_alg?: string | null
          sealed_under?: string
        }
        Relationships: [
          {
            foreignKeyName: "encrypted_transactions_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "connections"
            referencedColumns: ["id"]
          },
        ]
      }
      exchange_rate_resolutions: {
        Row: {
          fetched_at: string
          id: string
          median_calculation: string | null
          outliers_discarded: Json | null
          provider_responses: Json
          providers_failed: Json | null
          providers_succeeded: string[]
          rate_id: string
        }
        Insert: {
          fetched_at: string
          id?: string
          median_calculation?: string | null
          outliers_discarded?: Json | null
          provider_responses: Json
          providers_failed?: Json | null
          providers_succeeded: string[]
          rate_id: string
        }
        Update: {
          fetched_at?: string
          id?: string
          median_calculation?: string | null
          outliers_discarded?: Json | null
          provider_responses?: Json
          providers_failed?: Json | null
          providers_succeeded?: string[]
          rate_id?: string
        }
        Relationships: []
      }
      exchange_rates: {
        Row: {
          bucket_ts: string
          composite: boolean
          composite_via: string | null
          computed_at: string
          fetched_at: string
          granularity: string
          id: string
          product: string
          provenance: string
          provider_count: number
          rate: number
          source_authority: string
          source_currency: string
          status: string
          superseded_by_id: string | null
          target_currency: string
          tier: string
        }
        Insert: {
          bucket_ts: string
          composite?: boolean
          composite_via?: string | null
          computed_at: string
          fetched_at: string
          granularity: string
          id?: string
          product: string
          provenance?: string
          provider_count: number
          rate: number
          source_authority?: string
          source_currency: string
          status: string
          superseded_by_id?: string | null
          target_currency: string
          tier: string
        }
        Update: {
          bucket_ts?: string
          composite?: boolean
          composite_via?: string | null
          computed_at?: string
          fetched_at?: string
          granularity?: string
          id?: string
          product?: string
          provenance?: string
          provider_count?: number
          rate?: number
          source_authority?: string
          source_currency?: string
          status?: string
          superseded_by_id?: string | null
          target_currency?: string
          tier?: string
        }
        Relationships: []
      }
      invoices: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          customer_id: string
          due_date: string | null
          encrypted_payload: string | null
          encrypted_payload_kv: number | null
          hosted_invoice_url: string | null
          id: string
          paid_at: string | null
          status: string
          stripe_invoice_id: string | null
          subscription_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency?: string
          customer_id: string
          due_date?: string | null
          encrypted_payload?: string | null
          encrypted_payload_kv?: number | null
          hosted_invoice_url?: string | null
          id?: string
          paid_at?: string | null
          status?: string
          stripe_invoice_id?: string | null
          subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          customer_id?: string
          due_date?: string | null
          encrypted_payload?: string | null
          encrypted_payload_kv?: number | null
          hosted_invoice_url?: string | null
          id?: string
          paid_at?: string | null
          status?: string
          stripe_invoice_id?: string | null
          subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      opk_key_rotations: {
        Row: {
          id: string
          new_opk_alg: string
          new_opk_public: string
          old_opk_alg: string | null
          old_opk_public: string | null
          platform_id: string
          request_ip: string | null
          rotated_at: string
          rotation_reason: string | null
          subaccount_id: string
        }
        Insert: {
          id?: string
          new_opk_alg: string
          new_opk_public: string
          old_opk_alg?: string | null
          old_opk_public?: string | null
          platform_id: string
          request_ip?: string | null
          rotated_at?: string
          rotation_reason?: string | null
          subaccount_id: string
        }
        Update: {
          id?: string
          new_opk_alg?: string
          new_opk_public?: string
          old_opk_alg?: string | null
          old_opk_public?: string | null
          platform_id?: string
          request_ip?: string | null
          rotated_at?: string
          rotation_reason?: string | null
          subaccount_id?: string
        }
        Relationships: []
      }
      orbi_api_keys: {
        Row: {
          consumer_id: string
          consumer_name: string
          created_at: string
          created_by: string
          id: string
          key_hash: string
          key_prefix: string
          revoked_at: string | null
        }
        Insert: {
          consumer_id: string
          consumer_name: string
          created_at?: string
          created_by: string
          id?: string
          key_hash: string
          key_prefix: string
          revoked_at?: string | null
        }
        Update: {
          consumer_id?: string
          consumer_name?: string
          created_at?: string
          created_by?: string
          id?: string
          key_hash?: string
          key_prefix?: string
          revoked_at?: string | null
        }
        Relationships: []
      }
      orbi_usage_log: {
        Row: {
          asset: string
          batch_size: number
          consumer_id: string
          fiat: string
          fill_type: string
          http_status: number
          id: number
          key_prefix: string
          requested_at: string | null
          served_at: string
        }
        Insert: {
          asset: string
          batch_size: number
          consumer_id: string
          fiat: string
          fill_type: string
          http_status: number
          id?: number
          key_prefix: string
          requested_at?: string | null
          served_at?: string
        }
        Update: {
          asset?: string
          batch_size?: number
          consumer_id?: string
          fiat?: string
          fill_type?: string
          http_status?: number
          id?: number
          key_prefix?: string
          requested_at?: string | null
          served_at?: string
        }
        Relationships: []
      }
      org_recovery_challenges: {
        Row: {
          consumed_at: string | null
          issued_at: string
          nonce_bytes: string
          nonce_id: string
          source_ip: string | null
          vault_id: string
        }
        Insert: {
          consumed_at?: string | null
          issued_at?: string
          nonce_bytes: string
          nonce_id?: string
          source_ip?: string | null
          vault_id: string
        }
        Update: {
          consumed_at?: string | null
          issued_at?: string
          nonce_bytes?: string
          nonce_id?: string
          source_ip?: string | null
          vault_id?: string
        }
        Relationships: []
      }
      org_vault_meta: {
        Row: {
          break_glass_available_at: string | null
          break_glass_notify_at: string | null
          created_at: string
          customer_id: string
          org_recovery_kem_pubkey: string
          org_recovery_sig_pubkey: string
          org_vault_recovery_slot: string
          recovery_code_seen_by: string[]
          recovery_slot_version: number
          rotation_required: boolean
          vault_id: string
          vault_version: number
        }
        Insert: {
          break_glass_available_at?: string | null
          break_glass_notify_at?: string | null
          created_at?: string
          customer_id: string
          org_recovery_kem_pubkey: string
          org_recovery_sig_pubkey: string
          org_vault_recovery_slot: string
          recovery_code_seen_by?: string[]
          recovery_slot_version?: number
          rotation_required?: boolean
          vault_id: string
          vault_version?: number
        }
        Update: {
          break_glass_available_at?: string | null
          break_glass_notify_at?: string | null
          created_at?: string
          customer_id?: string
          org_recovery_kem_pubkey?: string
          org_recovery_sig_pubkey?: string
          org_vault_recovery_slot?: string
          recovery_code_seen_by?: string[]
          recovery_slot_version?: number
          rotation_required?: boolean
          vault_id?: string
          vault_version?: number
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          customer_id: string
          encrypted_payload: string | null
          encrypted_payload_kv: number | null
          failure_reason: string | null
          id: string
          invoice_id: string
          provider_payment_id: string | null
          rail: string
          status: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency?: string
          customer_id: string
          encrypted_payload?: string | null
          encrypted_payload_kv?: number | null
          failure_reason?: string | null
          id?: string
          invoice_id: string
          provider_payment_id?: string | null
          rail: string
          status?: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          customer_id?: string
          encrypted_payload?: string | null
          encrypted_payload_kv?: number | null
          failure_reason?: string | null
          id?: string
          invoice_id?: string
          provider_payment_id?: string | null
          rail?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_widget_sessions: {
        Row: {
          app_user_id: string
          completed_connection_id: string | null
          created_at: string
          expires_at: string
          id: string
          platform_id: string
          used_at: string | null
        }
        Insert: {
          app_user_id: string
          completed_connection_id?: string | null
          created_at?: string
          expires_at: string
          id?: string
          platform_id: string
          used_at?: string | null
        }
        Update: {
          app_user_id?: string
          completed_connection_id?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          platform_id?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pending_widget_sessions_platform_id_fkey"
            columns: ["platform_id"]
            isOneToOne: false
            referencedRelation: "platforms"
            referencedColumns: ["id"]
          },
        ]
      }
      pg_net_cron_state: {
        Row: {
          endpoint_path: string
          job_name: string
          last_check_status: string | null
          last_checked_at: string | null
          last_checked_request_id: number | null
          last_error: string | null
          last_request_id: number | null
          last_requested_at: string | null
          last_status_code: number | null
          last_timed_out: boolean | null
          timeout_milliseconds: number
        }
        Insert: {
          endpoint_path: string
          job_name: string
          last_check_status?: string | null
          last_checked_at?: string | null
          last_checked_request_id?: number | null
          last_error?: string | null
          last_request_id?: number | null
          last_requested_at?: string | null
          last_status_code?: number | null
          last_timed_out?: boolean | null
          timeout_milliseconds: number
        }
        Update: {
          endpoint_path?: string
          job_name?: string
          last_check_status?: string | null
          last_checked_at?: string | null
          last_checked_request_id?: number | null
          last_error?: string | null
          last_request_id?: number | null
          last_requested_at?: string | null
          last_status_code?: number | null
          last_timed_out?: boolean | null
          timeout_milliseconds?: number
        }
        Relationships: []
      }
      platform_key_audit: {
        Row: {
          action: string
          actor: string
          created_at: string
          env: string
          id: string
          platform_id: string | null
          platform_slug: string
        }
        Insert: {
          action: string
          actor: string
          created_at?: string
          env: string
          id?: string
          platform_id?: string | null
          platform_slug: string
        }
        Update: {
          action?: string
          actor?: string
          created_at?: string
          env?: string
          id?: string
          platform_id?: string | null
          platform_slug?: string
        }
        Relationships: []
      }
      platform_rate_limits: {
        Row: {
          count: number
          key: string
          scope: string
          window_start: string
        }
        Insert: {
          count?: number
          key: string
          scope: string
          window_start: string
        }
        Update: {
          count?: number
          key?: string
          scope?: string
          window_start?: string
        }
        Relationships: []
      }
      platforms: {
        Row: {
          api_key_hash: string
          api_key_prefix: string | null
          app_profile_slug: string | null
          bootstrap_ttl_seconds: number
          cors_origin: string | null
          created_at: string
          customer_id: string | null
          display_brand_color: string | null
          display_name: string | null
          env: string
          id: string
          is_internal: boolean
          name: string
          quiltt_api_key: string | null
          quiltt_api_key_id: string | null
          quiltt_catalog_profile_id: string | null
          quiltt_connector_id_link: string | null
          quiltt_connector_id_reconnect: string | null
          quiltt_environment_id: string | null
          rotated_at: string | null
          sink_format: string | null
          slug: string
          status: string
          tier: string
          updated_at: string
          webhook_secret: string | null
          webhook_url: string | null
          widget_url: string | null
        }
        Insert: {
          api_key_hash: string
          api_key_prefix?: string | null
          app_profile_slug?: string | null
          bootstrap_ttl_seconds?: number
          cors_origin?: string | null
          created_at?: string
          customer_id?: string | null
          display_brand_color?: string | null
          display_name?: string | null
          env?: string
          id?: string
          is_internal?: boolean
          name: string
          quiltt_api_key?: string | null
          quiltt_api_key_id?: string | null
          quiltt_catalog_profile_id?: string | null
          quiltt_connector_id_link?: string | null
          quiltt_connector_id_reconnect?: string | null
          quiltt_environment_id?: string | null
          rotated_at?: string | null
          sink_format?: string | null
          slug: string
          status?: string
          tier?: string
          updated_at?: string
          webhook_secret?: string | null
          webhook_url?: string | null
          widget_url?: string | null
        }
        Update: {
          api_key_hash?: string
          api_key_prefix?: string | null
          app_profile_slug?: string | null
          bootstrap_ttl_seconds?: number
          cors_origin?: string | null
          created_at?: string
          customer_id?: string | null
          display_brand_color?: string | null
          display_name?: string | null
          env?: string
          id?: string
          is_internal?: boolean
          name?: string
          quiltt_api_key?: string | null
          quiltt_api_key_id?: string | null
          quiltt_catalog_profile_id?: string | null
          quiltt_connector_id_link?: string | null
          quiltt_connector_id_reconnect?: string | null
          quiltt_environment_id?: string | null
          rotated_at?: string | null
          sink_format?: string | null
          slug?: string
          status?: string
          tier?: string
          updated_at?: string
          webhook_secret?: string | null
          webhook_url?: string | null
          widget_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platforms_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      queue_health_alert_state: {
        Row: {
          last_notified_at: string
          queue: string
        }
        Insert: {
          last_notified_at: string
          queue: string
        }
        Update: {
          last_notified_at?: string
          queue?: string
        }
        Relationships: []
      }
      quiltt_institutions_cache: {
        Row: {
          connector_id: string
          institution_id: string
          logo_url: string | null
          name: string
          raw: Json | null
          refreshed_at: string
          searchable: string
        }
        Insert: {
          connector_id: string
          institution_id: string
          logo_url?: string | null
          name: string
          raw?: Json | null
          refreshed_at?: string
          searchable: string
        }
        Update: {
          connector_id?: string
          institution_id?: string
          logo_url?: string | null
          name?: string
          raw?: Json | null
          refreshed_at?: string
          searchable?: string
        }
        Relationships: []
      }
      quiltt_profile_map: {
        Row: {
          created_at: string
          platform_id: string
          quiltt_environment_id: string
          quiltt_profile_id: string
          subaccount_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          platform_id: string
          quiltt_environment_id: string
          quiltt_profile_id: string
          subaccount_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          platform_id?: string
          quiltt_environment_id?: string
          quiltt_profile_id?: string
          subaccount_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      quiltt_webhook_inbox: {
        Row: {
          attempts: number
          event_id: string
          event_type: string
          last_error: string | null
          opk_deferred_at: string | null
          payload: Json
          platform_id: string | null
          processed_at: string | null
          received_at: string
          retirement_reason: string | null
          subaccount_id: string | null
        }
        Insert: {
          attempts?: number
          event_id: string
          event_type: string
          last_error?: string | null
          opk_deferred_at?: string | null
          payload: Json
          platform_id?: string | null
          processed_at?: string | null
          received_at?: string
          retirement_reason?: string | null
          subaccount_id?: string | null
        }
        Update: {
          attempts?: number
          event_id?: string
          event_type?: string
          last_error?: string | null
          opk_deferred_at?: string | null
          payload?: Json
          platform_id?: string | null
          processed_at?: string | null
          received_at?: string
          retirement_reason?: string | null
          subaccount_id?: string | null
        }
        Relationships: []
      }
      source_wallets: {
        Row: {
          connection_id: string
          created_at: string
          discovery_source: string | null
          encrypted_metadata: string | null
          encrypted_metadata_key_version: number | null
          external_wallet_id: string
          id: string
          is_synced: boolean
          wallet_fingerprint: string | null
          wallet_fingerprint_key_version: number | null
        }
        Insert: {
          connection_id: string
          created_at?: string
          discovery_source?: string | null
          encrypted_metadata?: string | null
          encrypted_metadata_key_version?: number | null
          external_wallet_id: string
          id?: string
          is_synced?: boolean
          wallet_fingerprint?: string | null
          wallet_fingerprint_key_version?: number | null
        }
        Update: {
          connection_id?: string
          created_at?: string
          discovery_source?: string | null
          encrypted_metadata?: string | null
          encrypted_metadata_key_version?: number | null
          external_wallet_id?: string
          id?: string
          is_synced?: boolean
          wallet_fingerprint?: string | null
          wallet_fingerprint_key_version?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "source_wallets_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "connections"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_users: {
        Row: {
          granted_at: string
          granted_by: string | null
          notes: string | null
          user_id: string
        }
        Insert: {
          granted_at?: string
          granted_by?: string | null
          notes?: string | null
          user_id: string
        }
        Update: {
          granted_at?: string
          granted_by?: string | null
          notes?: string | null
          user_id?: string
        }
        Relationships: []
      }
      stealth_connections: {
        Row: {
          app_slug: string
          app_user_id: string
          blind_index_b64: string | null
          connection_kind: string
          created_at: string
          id: string
          last_block_scanned: number | null
          last_sync_at: string | null
          last_sync_attempt_at: string | null
          platform_id: string
          scan_generation: string
          sealed_envelope: Json
          status: string
          updated_at: string
          wallet_birthday_plaintext: string | null
        }
        Insert: {
          app_slug: string
          app_user_id: string
          blind_index_b64?: string | null
          connection_kind: string
          created_at?: string
          id?: string
          last_block_scanned?: number | null
          last_sync_at?: string | null
          last_sync_attempt_at?: string | null
          platform_id: string
          scan_generation?: string
          sealed_envelope: Json
          status?: string
          updated_at?: string
          wallet_birthday_plaintext?: string | null
        }
        Update: {
          app_slug?: string
          app_user_id?: string
          blind_index_b64?: string | null
          connection_kind?: string
          created_at?: string
          id?: string
          last_block_scanned?: number | null
          last_sync_at?: string | null
          last_sync_attempt_at?: string | null
          platform_id?: string
          scan_generation?: string
          sealed_envelope?: Json
          status?: string
          updated_at?: string
          wallet_birthday_plaintext?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stealth_connections_platform_id_fkey"
            columns: ["platform_id"]
            isOneToOne: false
            referencedRelation: "platforms"
            referencedColumns: ["id"]
          },
        ]
      }
      stealth_scan_ranges: {
        Row: {
          connection_id: string
          from_height: number
          to_height: number
        }
        Insert: {
          connection_id: string
          from_height: number
          to_height: number
        }
        Update: {
          connection_id?: string
          from_height?: number
          to_height?: number
        }
        Relationships: []
      }
      stealth_transactions: {
        Row: {
          block_hash: string | null
          block_height: number
          connection_id: string
          created_at: string
          id: string
          occurred_at: string
          orphaned_at: string | null
          sealed_record: Json
          txid_blind_index_hex: string
        }
        Insert: {
          block_hash?: string | null
          block_height: number
          connection_id: string
          created_at?: string
          id?: string
          occurred_at: string
          orphaned_at?: string | null
          sealed_record: Json
          txid_blind_index_hex: string
        }
        Update: {
          block_hash?: string | null
          block_height?: number
          connection_id?: string
          created_at?: string
          id?: string
          occurred_at?: string
          orphaned_at?: string | null
          sealed_record?: Json
          txid_blind_index_hex?: string
        }
        Relationships: [
          {
            foreignKeyName: "stealth_transactions_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "stealth_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      stealth_utxos: {
        Row: {
          connection_id: string
          id: string
          scanned_to: number
          sealed_utxos: Json
          updated_at: string
        }
        Insert: {
          connection_id: string
          id?: string
          scanned_to: number
          sealed_utxos: Json
          updated_at?: string
        }
        Update: {
          connection_id?: string
          id?: string
          scanned_to?: number
          sealed_utxos?: Json
          updated_at?: string
        }
        Relationships: []
      }
      strike_webhook_events: {
        Row: {
          connection_id: string
          entity_id: string
          event_type: string
          id: string
          processed_at: string | null
          received_at: string
          strike_event_id: string
        }
        Insert: {
          connection_id: string
          entity_id: string
          event_type: string
          id?: string
          processed_at?: string | null
          received_at?: string
          strike_event_id: string
        }
        Update: {
          connection_id?: string
          entity_id?: string
          event_type?: string
          id?: string
          processed_at?: string | null
          received_at?: string
          strike_event_id?: string
        }
        Relationships: []
      }
      subaccounts: {
        Row: {
          created_at: string
          external_user_id: string
          id: string
          opk_alg: string | null
          opk_public: string | null
          opk_registered_at: string | null
          platform_id: string
        }
        Insert: {
          created_at?: string
          external_user_id: string
          id?: string
          opk_alg?: string | null
          opk_public?: string | null
          opk_registered_at?: string | null
          platform_id: string
        }
        Update: {
          created_at?: string
          external_user_id?: string
          id?: string
          opk_alg?: string | null
          opk_public?: string | null
          opk_registered_at?: string | null
          platform_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subaccounts_platform_id_fkey"
            columns: ["platform_id"]
            isOneToOne: false
            referencedRelation: "platforms"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          customer_id: string
          encrypted_payload: string | null
          encrypted_payload_kv: number | null
          id: string
          plan: string
          status: string
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          customer_id: string
          encrypted_payload?: string | null
          encrypted_payload_kv?: number | null
          id?: string
          plan: string
          status: string
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          customer_id?: string
          encrypted_payload?: string | null
          encrypted_payload_kv?: number | null
          id?: string
          plan?: string
          status?: string
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      user_app_grants: {
        Row: {
          access_token_hash: string
          app_id: string
          expires_at: string | null
          granted_at: string
          granted_scopes: string[]
          id: string
          last_used_at: string | null
          revoked_at: string | null
          rotated_at: string | null
          user_id: string
        }
        Insert: {
          access_token_hash: string
          app_id: string
          expires_at?: string | null
          granted_at?: string
          granted_scopes?: string[]
          id?: string
          last_used_at?: string | null
          revoked_at?: string | null
          rotated_at?: string | null
          user_id: string
        }
        Update: {
          access_token_hash?: string
          app_id?: string
          expires_at?: string | null
          granted_at?: string
          granted_scopes?: string[]
          id?: string
          last_used_at?: string | null
          revoked_at?: string | null
          rotated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_app_grants_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "apps"
            referencedColumns: ["id"]
          },
        ]
      }
      user_vault_keyring_watermark: {
        Row: {
          max_keyring_epoch: number
          updated_at: string
          user_id: string
        }
        Insert: {
          max_keyring_epoch: number
          updated_at?: string
          user_id: string
        }
        Update: {
          max_keyring_epoch?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_vault_meta: {
        Row: {
          created_at: string
          enc_mek_ciphertext: string | null
          kdf_algorithm: string
          kdf_params: Json
          kem_public_key: string | null
          kem_secret_wrapped: string | null
          keyring_ciphertext: string | null
          keyring_epoch: number
          pqc_key_version: number
          recovery_ciphertext: string | null
          sig_public_key: string | null
          sig_secret_wrapped: string | null
          updated_at: string
          user_id: string
          vault_key_version: number
          vault_salt: string
          vault_verifier_ciphertext: string
          workspace_key_id: string | null
        }
        Insert: {
          created_at?: string
          enc_mek_ciphertext?: string | null
          kdf_algorithm?: string
          kdf_params?: Json
          kem_public_key?: string | null
          kem_secret_wrapped?: string | null
          keyring_ciphertext?: string | null
          keyring_epoch?: number
          pqc_key_version?: number
          recovery_ciphertext?: string | null
          sig_public_key?: string | null
          sig_secret_wrapped?: string | null
          updated_at?: string
          user_id: string
          vault_key_version?: number
          vault_salt: string
          vault_verifier_ciphertext: string
          workspace_key_id?: string | null
        }
        Update: {
          created_at?: string
          enc_mek_ciphertext?: string | null
          kdf_algorithm?: string
          kdf_params?: Json
          kem_public_key?: string | null
          kem_secret_wrapped?: string | null
          keyring_ciphertext?: string | null
          keyring_epoch?: number
          pqc_key_version?: number
          recovery_ciphertext?: string | null
          sig_public_key?: string | null
          sig_secret_wrapped?: string | null
          updated_at?: string
          user_id?: string
          vault_key_version?: number
          vault_salt?: string
          vault_verifier_ciphertext?: string
          workspace_key_id?: string | null
        }
        Relationships: []
      }
      user_vault_pubkeys: {
        Row: {
          enc_x25519_privkey: string
          recovery_enc_x25519_privkey: string
          registered_at: string
          user_id: string
          x25519_public_key: string
        }
        Insert: {
          enc_x25519_privkey: string
          recovery_enc_x25519_privkey: string
          registered_at?: string
          user_id: string
          x25519_public_key: string
        }
        Update: {
          enc_x25519_privkey?: string
          recovery_enc_x25519_privkey?: string
          registered_at?: string
          user_id?: string
          x25519_public_key?: string
        }
        Relationships: []
      }
      vault_blobs: {
        Row: {
          ciphertext: string
          created_at: string
          id: string
          updated_at: string
          vault_id: string
        }
        Insert: {
          ciphertext: string
          created_at?: string
          id?: string
          updated_at?: string
          vault_id: string
        }
        Update: {
          ciphertext?: string
          created_at?: string
          id?: string
          updated_at?: string
          vault_id?: string
        }
        Relationships: []
      }
      vault_member_slots: {
        Row: {
          added_at: string
          added_by: string
          last_vault_activity_at: string
          member_slot: string
          member_user_id: string
          role: string
          vault_id: string
        }
        Insert: {
          added_at?: string
          added_by: string
          last_vault_activity_at?: string
          member_slot: string
          member_user_id: string
          role: string
          vault_id: string
        }
        Update: {
          added_at?: string
          added_by?: string
          last_vault_activity_at?: string
          member_slot?: string
          member_user_id?: string
          role?: string
          vault_id?: string
        }
        Relationships: []
      }
      vault_security_events: {
        Row: {
          created_at: string
          event: string
          id: string
          metadata: Json | null
          user_id: string
        }
        Insert: {
          created_at?: string
          event: string
          id?: string
          metadata?: Json | null
          user_id: string
        }
        Update: {
          created_at?: string
          event?: string
          id?: string
          metadata?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      waitlist: {
        Row: {
          created_at: string
          email: string
          id: string
          source: string | null
          use_case: string | null
          utm_campaign: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          source?: string | null
          use_case?: string | null
          utm_campaign?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          source?: string | null
          use_case?: string | null
          utm_campaign?: string | null
        }
        Relationships: []
      }
      webhook_delivery: {
        Row: {
          attempts: number
          created_at: string
          event_id: string
          event_type: string
          id: string
          last_attempt_at: string | null
          last_error: string | null
          payload: Json
          platform_id: string
          subaccount_id: string | null
          succeeded_at: string | null
        }
        Insert: {
          attempts?: number
          created_at?: string
          event_id?: string
          event_type: string
          id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          payload: Json
          platform_id: string
          subaccount_id?: string | null
          succeeded_at?: string | null
        }
        Update: {
          attempts?: number
          created_at?: string
          event_id?: string
          event_type?: string
          id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          payload?: Json
          platform_id?: string
          subaccount_id?: string | null
          succeeded_at?: string | null
        }
        Relationships: []
      }
      workspace_admins: {
        Row: {
          added_at: string
          admin_user_id: string
          id: string
          owner_user_id: string
        }
        Insert: {
          added_at?: string
          admin_user_id: string
          id?: string
          owner_user_id: string
        }
        Update: {
          added_at?: string
          admin_user_id?: string
          id?: string
          owner_user_id?: string
        }
        Relationships: []
      }
      wrapped_data_keys: {
        Row: {
          algorithm: string
          coadmin_keyring_ciphertext: string | null
          created_at: string
          data_key_id: string
          grant_sig: string
          grant_sig_alg: string
          id: string
          recipient_user_id: string
          wrapped_cak: string | null
          wrapped_ciphertext: string | null
        }
        Insert: {
          algorithm?: string
          coadmin_keyring_ciphertext?: string | null
          created_at?: string
          data_key_id: string
          grant_sig: string
          grant_sig_alg?: string
          id?: string
          recipient_user_id: string
          wrapped_cak?: string | null
          wrapped_ciphertext?: string | null
        }
        Update: {
          algorithm?: string
          coadmin_keyring_ciphertext?: string | null
          created_at?: string
          data_key_id?: string
          grant_sig?: string
          grant_sig_alg?: string
          id?: string
          recipient_user_id?: string
          wrapped_cak?: string | null
          wrapped_ciphertext?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      platform_rate_limits_stale: {
        Row: {
          count: number | null
          key: string | null
          scope: string | null
          window_start: string | null
        }
        Relationships: []
      }
      v_platform_quiltt_config: {
        Row: {
          platform_id: string | null
          quiltt_api_key: string | null
          quiltt_api_key_id: string | null
          quiltt_catalog_profile_id: string | null
          quiltt_connector_id_link: string | null
          quiltt_connector_id_reconnect: string | null
          sink_format: string | null
          slug: string | null
          tier: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      allocate_workspace_key: { Args: never; Returns: string }
      cleanup_expired_widget_sessions: { Args: never; Returns: number }
      create_or_access_token: { Args: { app_slug: string }; Returns: string }
      get_coadmin_emails: {
        Args: { user_ids: string[] }
        Returns: {
          email: string
          user_id: string
        }[]
      }
      get_or_create_direct_subaccount: { Args: never; Returns: string }
      is_staff: { Args: never; Returns: boolean }
      list_coadmin_workspaces: {
        Args: never
        Returns: {
          owner_user_id: string
          sig_public_key: string
          workspace_key_id: string
        }[]
      }
      list_or_access_tokens: {
        Args: never
        Returns: {
          app_name: string
          app_slug: string
          expires_at: string
          granted_at: string
          id: string
          last_used_at: string
          revoked_at: string
          rotated_at: string
        }[]
      }
      lookup_user_for_coadmin: {
        Args: { target_email: string }
        Returns: {
          kem_public_key: string
          user_id: string
        }[]
      }
      revoke_or_access_token: {
        Args: { raw_token: string }
        Returns: undefined
      }
      rotate_or_access_token: { Args: { p_grant_id: string }; Returns: string }
    }
    Enums: {
      agent_kind:
        | "claude_code"
        | "claude_desktop"
        | "chatgpt"
        | "cursor"
        | "continue"
        | "cline"
        | "custom"
      agent_role: "read_only" | "bookkeeper" | "accountant" | "owner"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      agent_kind: [
        "claude_code",
        "claude_desktop",
        "chatgpt",
        "cursor",
        "continue",
        "cline",
        "custom",
      ],
      agent_role: ["read_only", "bookkeeper", "accountant", "owner"],
    },
  },
} as const
