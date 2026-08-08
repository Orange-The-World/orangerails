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
      connections: {
        Row: {
          created_at: string
          credentials_key_version: number
          encrypted_credentials: string
          encrypted_label: string | null
          encrypted_last_error: string | null
          id: string
          last_sync_at: string | null
          last_sync_cursor: string | null
          provider_type: string
          status: string
          subaccount_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          credentials_key_version?: number
          encrypted_credentials: string
          encrypted_label?: string | null
          encrypted_last_error?: string | null
          id?: string
          last_sync_at?: string | null
          last_sync_cursor?: string | null
          provider_type: string
          status?: string
          subaccount_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          credentials_key_version?: number
          encrypted_credentials?: string
          encrypted_label?: string | null
          encrypted_last_error?: string | null
          id?: string
          last_sync_at?: string | null
          last_sync_cursor?: string | null
          provider_type?: string
          status?: string
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
          pqc_key_version: number
          recovery_ciphertext: string | null
          sig_public_key: string | null
          sig_secret_wrapped: string | null
          updated_at: string
          vault_key_version: number
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
          pqc_key_version?: number
          recovery_ciphertext?: string | null
          sig_public_key?: string | null
          sig_secret_wrapped?: string | null
          updated_at?: string
          vault_key_version?: number
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
          pqc_key_version?: number
          recovery_ciphertext?: string | null
          sig_public_key?: string | null
          sig_secret_wrapped?: string | null
          updated_at?: string
          vault_key_version?: number
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
      encrypted_transactions: {
        Row: {
          connection_id: string
          encrypted_payload: string
          external_id: string
          fetched_at: string
          hmac_counterparty: string | null
          hmac_direction: string | null
          hmac_type: string | null
          id: string
          occurred_at: string
          payload_key_version: number
        }
        Insert: {
          connection_id: string
          encrypted_payload: string
          external_id: string
          fetched_at?: string
          hmac_counterparty?: string | null
          hmac_direction?: string | null
          hmac_type?: string | null
          id?: string
          occurred_at: string
          payload_key_version?: number
        }
        Update: {
          connection_id?: string
          encrypted_payload?: string
          external_id?: string
          fetched_at?: string
          hmac_counterparty?: string | null
          hmac_direction?: string | null
          hmac_type?: string | null
          id?: string
          occurred_at?: string
          payload_key_version?: number
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
          created_at: string
          expires_at: string
          id: string
          platform_id: string
          used_at: string | null
        }
        Insert: {
          app_user_id: string
          created_at?: string
          expires_at: string
          id?: string
          platform_id: string
          used_at?: string | null
        }
        Update: {
          app_user_id?: string
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
      platforms: {
        Row: {
          api_key_hash: string
          cors_origin: string | null
          created_at: string
          customer_id: string | null
          display_brand_color: string | null
          display_name: string | null
          id: string
          is_internal: boolean
          name: string
          slug: string
          tier: string
          updated_at: string
        }
        Insert: {
          api_key_hash: string
          cors_origin?: string | null
          created_at?: string
          customer_id?: string | null
          display_brand_color?: string | null
          display_name?: string | null
          id?: string
          is_internal?: boolean
          name: string
          slug: string
          tier?: string
          updated_at?: string
        }
        Update: {
          api_key_hash?: string
          cors_origin?: string | null
          created_at?: string
          customer_id?: string | null
          display_brand_color?: string | null
          display_name?: string | null
          id?: string
          is_internal?: boolean
          name?: string
          slug?: string
          tier?: string
          updated_at?: string
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
      source_wallets: {
        Row: {
          connection_id: string
          created_at: string
          encrypted_metadata: string
          encrypted_metadata_key_version: number
          external_wallet_id: string
          id: string
          is_synced: boolean
        }
        Insert: {
          connection_id: string
          created_at?: string
          encrypted_metadata: string
          encrypted_metadata_key_version?: number
          external_wallet_id: string
          id?: string
          is_synced?: boolean
        }
        Update: {
          connection_id?: string
          created_at?: string
          encrypted_metadata?: string
          encrypted_metadata_key_version?: number
          external_wallet_id?: string
          id?: string
          is_synced?: boolean
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
          platform_id: string
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
          platform_id: string
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
          platform_id?: string
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
      stealth_transactions: {
        Row: {
          block_height: number
          connection_id: string
          created_at: string
          id: string
          occurred_at: string
          sealed_record: Json
          txid_blind_index_hex: string
        }
        Insert: {
          block_height: number
          connection_id: string
          created_at?: string
          id?: string
          occurred_at: string
          sealed_record: Json
          txid_blind_index_hex: string
        }
        Update: {
          block_height?: number
          connection_id?: string
          created_at?: string
          id?: string
          occurred_at?: string
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
      subaccounts: {
        Row: {
          created_at: string
          external_user_id: string
          id: string
          platform_id: string
        }
        Insert: {
          created_at?: string
          external_user_id: string
          id?: string
          platform_id: string
        }
        Update: {
          created_at?: string
          external_user_id?: string
          id?: string
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
      user_vault_meta: {
        Row: {
          created_at: string
          enc_mek_ciphertext: string | null
          kdf_algorithm: string
          kdf_params: Json
          kem_public_key: string | null
          kem_secret_wrapped: string | null
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
          created_at: string
          data_key_id: string
          id: string
          recipient_user_id: string
          wrapped_ciphertext: string
        }
        Insert: {
          algorithm?: string
          created_at?: string
          data_key_id: string
          id?: string
          recipient_user_id: string
          wrapped_ciphertext: string
        }
        Update: {
          algorithm?: string
          created_at?: string
          data_key_id?: string
          id?: string
          recipient_user_id?: string
          wrapped_ciphertext?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
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
      get_or_vault_salt: { Args: never; Returns: string }
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
      [_ in never]: never
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
    Enums: {},
  },
} as const
