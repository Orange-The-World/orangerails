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
          updated_at: string
          user_id: string
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
          updated_at?: string
          user_id: string
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
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      encrypted_transactions: {
        Row: {
          connection_id: string
          encrypted_payload: string
          external_id: string
          fetched_at: string
          id: string
          occurred_at: string
          payload_key_version: number
        }
        Insert: {
          connection_id: string
          encrypted_payload: string
          external_id: string
          fetched_at?: string
          id?: string
          occurred_at: string
          payload_key_version?: number
        }
        Update: {
          connection_id?: string
          encrypted_payload?: string
          external_id?: string
          fetched_at?: string
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
      user_app_grants: {
        Row: {
          access_token_hash: string
          app_id: string
          granted_at: string
          granted_scopes: string[]
          id: string
          last_used_at: string | null
          revoked_at: string | null
          user_id: string
        }
        Insert: {
          access_token_hash: string
          app_id: string
          granted_at?: string
          granted_scopes?: string[]
          id?: string
          last_used_at?: string | null
          revoked_at?: string | null
          user_id: string
        }
        Update: {
          access_token_hash?: string
          app_id?: string
          granted_at?: string
          granted_scopes?: string[]
          id?: string
          last_used_at?: string | null
          revoked_at?: string | null
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
          kdf_algorithm: string
          kdf_params: Json
          updated_at: string
          user_id: string
          vault_key_version: number
          vault_salt: string
          vault_verifier_ciphertext: string
        }
        Insert: {
          created_at?: string
          kdf_algorithm?: string
          kdf_params?: Json
          updated_at?: string
          user_id: string
          vault_key_version?: number
          vault_salt: string
          vault_verifier_ciphertext: string
        }
        Update: {
          created_at?: string
          kdf_algorithm?: string
          kdf_params?: Json
          updated_at?: string
          user_id?: string
          vault_key_version?: number
          vault_salt?: string
          vault_verifier_ciphertext?: string
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
  public: {
    Enums: {},
  },
} as const
