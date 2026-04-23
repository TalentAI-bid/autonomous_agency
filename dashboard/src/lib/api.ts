import axios, { type AxiosInstance, type AxiosResponse, AxiosError } from 'axios';
import type { ApiResponse, PaginatedResponse } from '@/types';
import { useAuthStore } from '@/stores/auth.store';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const axiosInstance: AxiosInstance = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { 'Content-Type': 'application/json' },
});

let onUnauthorized: (() => void) | null = null;

export function setAuthInterceptors(unauthorizedHandler: () => void) {
  onUnauthorized = unauthorizedHandler;
}

// Request interceptor — read token live from the store on every request so
// there is no window where a child useQuery effect can fire before a parent
// useEffect wires up auth.
axiosInstance.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor — auth is a single 7-day JWT, no refresh machinery.
// On 401, the token is either missing or expired; bounce the user to /login.
axiosInstance.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      onUnauthorized?.();
    }
    return Promise.reject(error);
  },
);

// Generic API helpers
export async function apiGet<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await axiosInstance.get(url, { params });
  return res.data.data;
}

export async function apiGetPaginated<T>(url: string, params?: Record<string, unknown>): Promise<PaginatedResponse<T>> {
  const res: AxiosResponse<PaginatedResponse<T>> = await axiosInstance.get(url, { params });
  return res.data;
}

export async function apiPost<T>(url: string, data?: unknown): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await axiosInstance.post(url, data);
  return res.data.data;
}

export async function apiPatch<T>(url: string, data?: unknown): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await axiosInstance.patch(url, data);
  return res.data.data;
}

export async function apiPut<T>(url: string, data?: unknown): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await axiosInstance.put(url, data);
  return res.data.data;
}

export async function apiDelete<T>(url: string): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await axiosInstance.delete(url);
  return res.data.data;
}

export async function apiUpload<T>(url: string, formData: FormData): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await axiosInstance.post(url, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data.data;
}

export default axiosInstance;
