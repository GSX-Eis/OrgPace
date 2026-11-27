import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import { useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"

import { type UpdatePassword, UsersService } from "@/client"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { LoadingButton } from "@/components/ui/loading-button"
import { PasswordInput } from "@/components/ui/password-input"
import useAuth from "@/hooks/useAuth"
import useCustomToast from "@/hooks/useCustomToast"
import { handleError } from "@/utils"

type FormData = {
  current_password: string
  new_password: string
  confirm_password: string
}

const ChangePassword = ({ onSuccess }: { onSuccess?: () => void }) => {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const { showSuccessToast, showErrorToast } = useCustomToast()
  const formSchema = useMemo(() => {
    const password = z
      .string()
      .min(1, { message: t("account.validation.passwordRequired") })
      .refine(
        (value) => [...value].length >= 8,
        t("account.validation.passwordMin"),
      )
      .refine(
        (value) => [...value].length <= 128,
        t("account.validation.passwordMax"),
      )

    return z
      .object({
        current_password: password,
        new_password: password,
        confirm_password: z
          .string()
          .min(1, { message: t("account.validation.confirmPasswordRequired") }),
      })
      .refine(
        (data) =>
          !data.new_password || data.new_password !== data.current_password,
        {
          message: t("account.validation.sameAsCurrent"),
          path: ["new_password"],
        },
      )
      .refine(
        (data) =>
          data.new_password.trim().toLowerCase() !==
          user?.username?.toLowerCase(),
        {
          message: t("account.validation.sameAsEmail"),
          path: ["new_password"],
        },
      )
      .refine((data) => data.new_password === data.confirm_password, {
        message: t("account.validation.mismatch"),
        path: ["confirm_password"],
      })
  }, [t, user?.username])

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    mode: "onChange",
    criteriaMode: "all",
    defaultValues: {
      current_password: "",
      new_password: "",
      confirm_password: "",
    },
  })

  const mutation = useMutation({
    mutationFn: (data: UpdatePassword) =>
      UsersService.updatePasswordMe({ body: data }),
    onSuccess: async ({ data }) => {
      localStorage.setItem("access_token", data.access_token)
      await queryClient.invalidateQueries({ queryKey: ["currentUser"] })
      showSuccessToast(t("account.passwordUpdated"))
      form.reset()
      onSuccess?.()
    },
    onError: handleError.bind(showErrorToast),
  })

  const onSubmit = async (data: FormData) => {
    mutation.mutate(data)
  }

  return (
    <div>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col gap-4"
        >
          <p className="text-sm text-muted-foreground">
            {t("account.changePasswordHint")}
          </p>
          <FormField
            control={form.control}
            name="current_password"
            rules={{ deps: "new_password" }}
            render={({ field, fieldState }) => (
              <FormItem>
                <FormLabel>{t("account.currentPasswordLabel")}</FormLabel>
                <FormControl>
                  <PasswordInput
                    data-testid="current-password-input"
                    placeholder="••••••••"
                    aria-invalid={fieldState.invalid}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="new_password"
            rules={{ deps: "confirm_password" }}
            render={({ field, fieldState }) => (
              <FormItem>
                <FormLabel>{t("account.newPasswordLabel")}</FormLabel>
                <FormControl>
                  <PasswordInput
                    data-testid="new-password-input"
                    placeholder="••••••••"
                    aria-invalid={fieldState.invalid}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="confirm_password"
            render={({ field, fieldState }) => (
              <FormItem>
                <FormLabel>{t("account.confirmPasswordLabel")}</FormLabel>
                <FormControl>
                  <PasswordInput
                    data-testid="confirm-password-input"
                    placeholder="••••••••"
                    aria-invalid={fieldState.invalid}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <LoadingButton type="submit" loading={mutation.isPending}>
            {t("account.savePasswordButton")}
          </LoadingButton>
        </form>
      </Form>
    </div>
  )
}

export default ChangePassword
