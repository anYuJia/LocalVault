import { useSearchStore } from "@/stores/search-store";

export function useSearch() {
  return useSearchStore();
}
