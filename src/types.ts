export type DeliveryType = "ONLINE" | "CC";

export type Address = {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  mobile: string;
  email: string;
};

export type Profile = {
  profileId: string;
  address: Address;
  card: {
    cardNumber: string;
    cardVerificationCode: string;
    expiryMonth: string;
    expiryYear: string;
    cardholderName: string;
  };
};

export type CheckoutTask = {
  taskId: string;
  profileId: string;
  productId: string;
  retryDelayMs: number;
  maxRetries: number;
  quantity: number;
};

export type AppConfig = {
  apiBaseUrl: string;
  taskCsvPath: string;
  tasks: CheckoutTask[];
  deliveryType: DeliveryType;
  profileCsvPath: string;
  discordWebhookUrl: string;
};

export type CheckoutConfig = Omit<AppConfig, "tasks"> & CheckoutTask;

export type Cart = {
  id?: string;
  hash?: string;
  termsAndConditionsVersion?: string;
};

export type DeliveryChoice = {
  id?: string;
};

export type DeliveryOption = {
  provider?: string;
  choices?: DeliveryChoice[];
};

export type DeliveryOptionsResponseItem = {
  id?: string;
  deliveryOptions?: DeliveryOption[];
};

export type SelectedDelivery = {
  deliveryId: string;
  deliveryOptionId: string;
  deliveryOptionProvider: string;
};
