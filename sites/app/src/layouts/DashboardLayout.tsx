import { Link, NavLink, Outlet } from "react-router-dom";
import { LayoutGrid, AppWindow, KeyRound, BarChart3, Receipt, Settings as SettingsIcon, LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth";

const nav = [
  { to: "/", label: "Overview", icon: LayoutGrid, end: true },
  { to: "/apps", label: "Apps", icon: AppWindow },
  { to: "/keys", label: "API keys", icon: KeyRound },
  { to: "/usage", label: "Usage", icon: BarChart3 },
  { to: "/billing", label: "Billing", icon: Receipt },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export default function DashboardLayout() {
  const { user, signOut } = useAuth();

  return (
    <div className="min-h-screen flex">
      <aside className="w-60 border-r border-slate-200 bg-slate-50 flex flex-col">
        <div className="px-6 py-5 border-b border-slate-200">
          <Link to="/" className="text-lg font-bold text-orange">Orange Rails</Link>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-sm ${
                  isActive
                    ? "bg-orange/10 text-orange font-medium"
                    : "text-slate-700 hover:bg-slate-100"
                }`
              }
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-3 py-4 border-t border-slate-200 text-sm">
          <div className="px-3 py-2 text-slate-600 truncate">{user?.email}</div>
          <button
            onClick={() => signOut()}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-slate-700 hover:bg-slate-100"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
