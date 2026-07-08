import { useRecommendedStore } from "@/stores/recommended-store";

export function useRecommended() {
  return useRecommendedStore();
}
